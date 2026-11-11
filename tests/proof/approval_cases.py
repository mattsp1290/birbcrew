import json
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4


def verify_approvals(runtime, running, start_worker, command, wait_until, sql):
    def spawn(engine):
        owner = f"decisions-{engine}-{uuid4()}"
        member = command("spawn", {"ownerId": owner, "requestId": str(uuid4()), "engine": engine,
                                   "profile": "fixture.approval.v1"})
        return {"ownerId": owner, "memberId": member["memberId"]}

    scope = (" WHERE conversation_id IN (SELECT conversation_id FROM birbcrew_ts.conversations "
             "JOIN birbcrew_ts.members USING (member_id) WHERE profile='fixture.approval.v1')")
    cases = []
    with ThreadPoolExecutor(max_workers=6) as calls:
        for engine in ["pi", "claude"]:
            member = spawn(engine)
            for choice in ["approve", "deny", "cancel"]:
                key = {"ownerId": member["ownerId"], "conversationId": str(uuid4())}
                command("open", {**key, "memberId": member["memberId"]})
                request = {"requestId": str(uuid4()), **key}
                future = calls.submit(command, "turn", {**request, "text": "record " + request["requestId"]})
                cases.append((engine, key, request, choice, future))
        expected = len(cases)
        wait_until(lambda: sql("SELECT count(*) FROM birbcrew_ts.paused_segments" + scope) == str(expected),
                   "six native tool deferrals committed")
        assert sql("SELECT count(*) FROM birbcrew_ts.work_items" + scope) == "0"
        running.kill()
        running.wait(timeout=10)
        replacement = start_worker(runtime)
        for engine, key, request, choice, future in cases:
            pending, = command("pending", key)
            assert pending["requestId"] == request["requestId"] and pending["nativeCallId"]
            decision = {k: pending[k] for k in ("ownerId", "memberId", "conversationId", "requestId", "nativeCallId",
                                                "invocationId", "approvalId", "version", "argumentDigest")}
            if choice == "cancel":
                assert command("cancel-pending", request) == {"cancelled": True}
                assert command("cancel-pending", request) == {"cancelled": True}
                expected_kind = "cancelled"
            else:
                decision["choice"] = choice
                command("decide", {**decision, "ownerId": "stranger"}, fail=True)
                command("decide", {**decision, "argumentDigest": "0"*64}, fail=True)
                command("decide", {**decision, "version": 2}, fail=True)
                assert command("decide", decision) == {"decision": choice}
                assert command("decide", decision) == {"decision": choice}
                expected_kind = "recorded" if choice == "approve" else "denied"
            reply = future.result(timeout=60)["text"]
            # The SDK fixture generates these replies from the native tool result.
            if engine == "pi":
                outcome = json.loads(reply.removeprefix("settled "))
                assert outcome["kind"] == expected_kind and outcome["nativeCallId"] == pending["nativeCallId"]
            elif expected_kind == "recorded":
                assert reply.startswith("recorded ") and len(reply.split()) == 2
            else:
                assert reply == expected_kind, reply
            if choice == "approve":
                receipt = sql("SELECT receipt_id FROM birbcrew_ts.work_items WHERE approval_id='" + pending["approvalId"] + "'")
                assert receipt and receipt in reply
            else:
                assert sql("SELECT count(*) FROM birbcrew_ts.work_items WHERE approval_id='" + pending["approvalId"] + "'") == "0"
            assert not command("pending", key)
    assert sql("SELECT count(*) FROM birbcrew_ts.work_items" + scope) == "2"
    print("Six native calls survived a worker replacement while paused. Only the two approvals wrote a work item.", flush=True)
    return replacement
