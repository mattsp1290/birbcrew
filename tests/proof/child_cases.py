import json
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4


def verify_children(runtime, current, worker, command, wait_until, sql):
    owner = "crew-" + str(uuid4())
    member = command(
        "spawn",
        {"ownerId": owner, "requestId": str(uuid4()), "engine": "pi", "profile": "fixture.crew.v1"},
    )

    def begin(executor, tasks, request_id=None):
        key = {"ownerId": owner, "conversationId": str(uuid4())}
        command("open", {**key, "memberId": member["memberId"]})
        request = {
            **key,
            "requestId": request_id or str(uuid4()),
            "text": "delegate " + json.dumps(tasks),
        }
        return key, request, executor.submit(command, "turn", request)

    def scope(request):
        return (
            f" WHERE request_id='{request['requestId']}' "
            f"AND conversation_id='{request['conversationId']}'"
        )

    def children(request):
        return json.loads(
            sql(
                "SELECT coalesce(json_agg(row_to_json(c) ORDER BY ordinal), '[]') FROM "
                "(SELECT child_id, ordinal, task, phase, native_call_id, workflow_run_id, outcome "
                "FROM birbcrew_ts.pi_children" + scope(request) + ") c"
            )
        )

    def items(request):
        return sql("SELECT count(*) FROM birbcrew_ts.work_items" + scope(request))

    def await_phases(request, future, phases):
        def reached():
            if future.done():
                future.result()
                raise AssertionError("Parent finished before children reached " + str(phases))
            return [row["phase"] for row in children(request)] == phases

        wait_until(reached, "Pi child phases " + str(phases))

    def decision(approval, choice):
        fields = (
            "ownerId",
            "memberId",
            "conversationId",
            "requestId",
            "invocationId",
            "nativeCallId",
            "approvalId",
            "version",
            "argumentDigest",
        )
        return {**{field: approval[field] for field in fields}, "choice": choice}

    def settled(request, future):
        response = future.result(timeout=90)
        assert response["text"].startswith("delegated "), response
        outcomes = json.loads(response["text"].removeprefix("delegated "))
        rows = children(request)
        assert [outcome["nativeCallId"] for outcome in outcomes] == [
            row["native_call_id"] for row in rows
        ]
        assert outcomes == [row["outcome"] for row in rows]
        assert len({row["workflow_run_id"] for row in rows}) == len(rows)
        assert all(row["workflow_run_id"] for row in rows)
        assert command("turn", request) == response
        assert children(request) == rows
        return outcomes

    def replace(process):
        process.kill()
        process.wait(timeout=10)
        return worker(runtime)

    with ThreadPoolExecutor(max_workers=3) as calls:
        tasks = [
            {"role": "recorder", "task": "record assigned " + label}
            for label in ["first", "second"]
        ]
        # Hold PostgreSQL's COMMIT response so the first activity cannot start the children.
        # The server finishes that transaction after the worker process has been killed.
        request_id = str(uuid4())
        gate = uuid4().int % 2**30 + 1
        lock = f" FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid={gate}"
        sql(f"""
            CREATE FUNCTION birbcrew_ts.proof_hold_intent() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_advisory_xact_lock({gate}); RETURN NULL; END; $$;
            CREATE CONSTRAINT TRIGGER proof_hold_intent
              AFTER INSERT ON birbcrew_ts.delegations DEFERRABLE INITIALLY DEFERRED
              FOR EACH ROW WHEN (NEW.request_id='{request_id}')
              EXECUTE FUNCTION birbcrew_ts.proof_hold_intent()
        """)
        holder = calls.submit(
            sql, f"BEGIN; SELECT pg_advisory_xact_lock({gate}); SELECT pg_sleep(120); COMMIT"
        )
        try:
            wait_until(
                lambda: sql("SELECT count(*)" + lock + " AND granted") == "1", "intent barrier held"
            )
            key, request, future = begin(calls, tasks, request_id)
            wait_until(
                lambda: sql("SELECT count(*)" + lock + " AND NOT granted") == "1",
                "intent committing",
            )
            current.kill()
            current.wait(timeout=10)
        finally:
            sql("SELECT pg_terminate_backend(pid)" + lock + " AND granted")
            holder.exception(timeout=10)
            sql(
                "DROP TRIGGER proof_hold_intent ON birbcrew_ts.delegations; "
                "DROP FUNCTION birbcrew_ts.proof_hold_intent()"
            )
        await_phases(request, future, ["ready", "ready"])
        intents = children(request)
        assert all(row["workflow_run_id"] is None for row in intents)
        current = worker(runtime)
        await_phases(request, future, ["waiting", "waiting"])
        before = children(request)
        assert [r["child_id"] for r in before] == [r["child_id"] for r in intents]
        assert items(request) == "0"
        current = replace(current)
        pending = command("pending", key)
        by_child = {p["invocationId"]: p for p in pending}
        assert set(by_child) == {row["child_id"] for row in before}
        assert all(p["requestId"] == request["requestId"] for p in pending)
        assert len({p["approvalId"] for p in pending}) == 2
        first, second = [decision(by_child[row["child_id"]], "approve") for row in before]
        for override in [
            {"ownerId": "unrelated"},
            {"requestId": str(uuid4())},
            {"invocationId": first["invocationId"]},
            {"nativeCallId": first["nativeCallId"]},
            {"argumentDigest": first["argumentDigest"]},
            {"version": 2},
        ]:
            command("decide", {**second, **override}, fail=True)
        # Let the later sibling consume the shared effect budget while the first stays paused.
        assert command("decide", second) == {"decision": "approve"}
        await_phases(request, future, ["waiting", "complete"])
        assert items(request) == "1"
        current = replace(current)
        assert command("decide", second) == {"decision": "approve"}
        assert command("decide", first) == {"decision": "approve"}
        outcomes = settled(request, future)
        assert [o["kind"] for o in outcomes] == ["completed", "completed"]
        protected = [json.loads(o["text"].removeprefix("settled ")) for o in outcomes]
        assert [(o["nativeCallId"], o["kind"]) for o in protected] == [
            (first["nativeCallId"], "budget_exhausted"),
            (second["nativeCallId"], "recorded"),
        ]
        receipt = protected[1]["receipt"]
        assert receipt["operationId"] == request["requestId"]
        assert (
            sql("SELECT receipt_id FROM birbcrew_ts.work_items" + scope(request))
            == receipt["receiptId"]
        )
        assert sql("SELECT note FROM birbcrew_ts.work_items" + scope(request)) == "second"
        assert not command("pending", key)

        key, request, future = begin(
            calls,
            [
                {"role": "analyst", "task": "fail"},
                {"role": "recorder", "task": "record assigned denied"},
            ],
        )
        await_phases(request, future, ["failed", "waiting"])
        (pending,) = command("pending", key)
        assert command("decide", decision(pending, "deny")) == {"decision": "deny"}
        failed, denied = settled(request, future)
        assert failed["kind"] == "failed" and failed["code"] == "child_failed"
        assert denied["kind"] == "completed"
        assert json.loads(denied["text"].removeprefix("settled ")) == {
            "kind": "denied",
            "nativeCallId": pending["nativeCallId"],
        }
        assert items(request) == "0" and not command("pending", key)

        key, request, future = begin(
            calls,
            [
                {"role": "analyst", "task": "child wait"},
                {"role": "recorder", "task": "record assigned cancelled"},
            ],
        )
        await_phases(request, future, ["running", "waiting"])
        (pending,) = command("pending", key)
        cancel = {**key, "requestId": request["requestId"]}
        assert command("cancel-pending", cancel) == {"cancelled": True}
        assert command("cancel-pending", cancel) == {"cancelled": True}
        assert [o["kind"] for o in settled(request, future)] == ["cancelled", "cancelled"]
        assert all(row["phase"] == "cancelled" for row in children(request))
        command("decide", decision(pending, "approve"), fail=True)
        assert items(request) == "0" and not command("pending", key)

        key, request, future = begin(calls, [{"role": role, "task": "next step"} for role in ["analyst", "recorder"]])
        assert [o["kind"] for o in settled(request, future)] == ["failed", "failed"]
        assert command("pending", key) == [] and items(request) == "0"
        assert sql("SELECT count(*) FROM birbcrew_ts.deferred_calls" + scope(request)) == "0"

    print(
        "Pi child intents survived replacement before workflow start. Siblings shared one effect "
        "and returned ordered results after denial, failure, and cancellation.",
        flush=True,
    )
    return current
