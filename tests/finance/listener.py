import asyncio
import json
import os
import sys
from pathlib import Path

from fastapi.responses import StreamingResponse

from birbcrew.finance import api, server

ROOT = Path(os.environ["FINANCE_PROOF_DIR"])


def event(kind, **values):
    with (ROOT / f"events-{os.getpid()}.jsonl").open("a") as stream:
        stream.write(json.dumps(dict(kind=kind, **values)) + "\n")


def instrument():
    factory = server.protocol_for

    def protocol(policy, context):
        cls = factory(policy, context)
        expire = cls.expire
        made = cls.connection_made

        def expiration(self):
            event("deadline_abort", scheduled_timer=sys._getframe(1).f_code.co_name == "_run")
            expire(self)

        def connected(self, transport):
            app = self.real_app

            async def counted(scope, receive, send):
                event("app_entry")
                await app(scope, receive, send)

            self.real_app = counted
            call_at = self.loop.call_at

            def schedule(when, callback, *args, **kwargs):
                if callback == self.expire:
                    mutant = os.environ.get("FINANCE_PROOF_TIMER")
                    if mutant == "delayed":
                        when += 3
                    elif mutant == "early":
                        when = self.loop.time() + 0.15
                    elif mutant == "unrelated":
                        callback = transport.abort
                return call_at(when, callback, *args, **kwargs)

            self.loop.call_at = schedule
            try:
                made(self, transport)
            finally:
                self.loop.call_at = call_at
            event("transport_accepted" if self.accepted else "transport_denied")

        cls.expire = expiration
        cls.connection_made = connected
        return cls

    server.protocol_for = protocol
    create = server.create_app

    def app(temporal):
        result = create(temporal)

        @result.get("/sse")
        async def sse():
            event("sse_entry")

            async def stream():
                yield b"data: synthetic\n\n"
                await asyncio.sleep(30)
                yield b"data: late\n\n"

            return StreamingResponse(stream(), media_type="text/event-stream")

        return result

    server.create_app = app
    ensure = api.ensure_workflow

    async def start(state, temporal):
        event("workflow_attempt")
        if os.environ.get("FINANCE_PROOF_CRASH") == "before":
            os._exit(71)
        await ensure(state, temporal)
        if os.environ.get("FINANCE_PROOF_CRASH") == "after":
            os._exit(72)

    api.ensure_workflow = start


if __name__ == "__main__":
    instrument()
    asyncio.run(server.main())
