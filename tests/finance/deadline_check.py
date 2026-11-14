import http.client
import json
import ssl
import subprocess
import time


class DeadlineAssertion(AssertionError):
    def __init__(self, observed):
        self.observed = observed
        super().__init__(observed)


def observe_deadline(identity, max_age, start_server, context, run):
    before = {p: p.stat().st_size for p in (run / "events").glob("events-*.jsonl")}
    child, port = start_server(max_age=max_age)
    cert = (
        subprocess.run(
            ["openssl", "x509", "-in", str(run / f"{identity}.crt"), "-noout", "-enddate"],
            cwd=run.parent,
            capture_output=True,
            text=True,
            check=True,
            timeout=5,
        )
        .stdout.strip()
        .split("=", 1)[1]
    )
    not_after = ssl.cert_time_to_seconds(cert)
    late_allowance = 0.5
    early_allowance = 0.1
    client = http.client.HTTPSConnection("127.0.0.1", port, context=context(identity), timeout=8)
    anchor = time.monotonic()
    wall = time.time()
    expiry_deadline = anchor + not_after - wall
    started = time.monotonic()
    first = b""
    body = b""
    outcome = None
    try:
        client.connect()
        connected = time.monotonic()
        client.request("GET", "/sse")
        response = client.getresponse()
        first = response.read(len(b"data: synthetic\n\n"))
        first_at = time.monotonic()
        try:
            body = first + response.read()
            outcome = "clean_close"
        except http.client.IncompleteRead as exc:
            body = first + exc.partial
            outcome = "incomplete_read"
        closed = time.monotonic()
    finally:
        client.close()
    expected_earliest = min(started + max_age, expiry_deadline)
    expected_latest = min(first_at + max_age, expiry_deadline)
    rows = [
        json.loads(line)
        for path in (run / "events").glob("events-*.jsonl")
        for line in path.read_text()[before.get(path, 0) :].splitlines()
    ]
    kinds = [row["kind"] for row in rows]
    observed = dict(
        elapsed_seconds=closed - started,
        outcome=outcome,
        first_frame=first == b"data: synthetic\n\n",
        late_frame=b"late" in body,
        max_age=max_age,
        leaf_not_after_unix=not_after,
        wall_anchor_unix=wall,
        monotonic_anchor=anchor,
        connection_start_monotonic=started,
        client_connected_monotonic=connected,
        first_frame_monotonic=first_at,
        observed_close_monotonic=closed,
        expected_deadline_earliest_monotonic=expected_earliest,
        expected_deadline_latest_monotonic=expected_latest,
        expected_deadline_seconds_from_start=expected_latest - started,
        late_allowance_seconds=late_allowance,
        early_allowance_seconds=early_allowance,
        deadline_source="certificate_expiry" if expiry_deadline < started + max_age else "max_age",
        deadline_abort_events=kinds.count("deadline_abort"),
        scheduled_timer_events=sum(
            row["kind"] == "deadline_abort" and row.get("scheduled_timer", False) for row in rows
        ),
        listener_pid=child.pid,
        response_status=response.status,
    )
    observed["correctness_passed"] = (
        response.status == 200
        and observed["first_frame"]
        and not observed["late_frame"]
        and outcome == "incomplete_read"
        and first_at - started <= 0.25
        and expected_earliest - early_allowance <= closed <= expected_latest + late_allowance
        and kinds.count("transport_accepted") == 1
        and kinds.count("sse_entry") == 1
        and observed["scheduled_timer_events"] == 1
    )
    if not observed["correctness_passed"]:
        raise DeadlineAssertion(observed)
    return observed
