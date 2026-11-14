import hashlib
import ssl
import time
from dataclasses import dataclass

from uvicorn.protocols.http.h11_impl import H11Protocol

from birbcrew.finance.config import ListenerSettings

EXTENSION = "birbcrew.finance.go"


@dataclass(frozen=True)
class GoService:
    certificate_sha256: str
    deadline: float
    not_after: float


async def rejected(scope, receive, send):
    await send({"type": "http.response.start", "status": 403, "headers": []})
    await send({"type": "http.response.body", "body": b""})


def protocol_for(policy: ListenerSettings, expected: ssl.SSLContext):
    class FinanceH11(H11Protocol):
        def __init__(self, config, server_state, app_state, _loop=None):
            super().__init__(config, server_state, app_state, _loop)
            self.accepted = False
            self.expiry = None
            self.real_app = self.app
            self.app = rejected

        def connection_made(self, transport):
            super().connection_made(transport)
            tls = transport.get_extra_info("ssl_object")
            try:
                if (
                    tls is None
                    or tls.context is not expected
                    or tls.context.verify_mode != ssl.CERT_REQUIRED
                    or tls.version() != "TLSv1.3"
                    or tls.session_reused
                ):
                    raise ValueError("transport")
                cert = tls.getpeercert()
                if [v for k, v in cert.get("subjectAltName", ()) if k == "URI"] != [
                    policy.service_uri
                ]:
                    raise ValueError("service")
                now = time.time()
                end = ssl.cert_time_to_seconds(cert["notAfter"])
                if not ssl.cert_time_to_seconds(cert["notBefore"]) <= now < end:
                    raise ValueError("validity")
                principal = GoService(
                    hashlib.sha256(tls.getpeercert(binary_form=True)).hexdigest(),
                    self.loop.time() + min(policy.max_connection_age, end - now),
                    end,
                )
            except (ValueError, KeyError):
                transport.abort()
                return
            self.accepted = True
            self.expiry = self.loop.call_at(principal.deadline, self.expire)

            async def bound(scope, receive, send):
                if self.loop.time() >= principal.deadline or time.time() >= principal.not_after:
                    self.expire()
                    return
                scope = dict(
                    scope, extensions={**scope.get("extensions", {}), EXTENSION: principal}
                )

                async def guarded_send(message):
                    if self.loop.time() >= principal.deadline or time.time() >= principal.not_after:
                        self.expire()
                        return
                    await send(message)

                await self.real_app(scope, receive, guarded_send)

            self.app = bound

        def expire(self):
            self.accepted = False
            self.transport.abort()

        def data_received(self, data):
            if self.accepted:
                super().data_received(data)

        def connection_lost(self, exc):
            if self.expiry:
                self.expiry.cancel()
            super().connection_lost(exc)

    return FinanceH11
