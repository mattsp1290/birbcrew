import ipaddress
import os
import ssl
import stat
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

from birbcrew.config import Settings, settings


class ListenerSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    host: str
    port: int = Field(ge=1, le=65535)
    certificate: Path
    private_key: Path
    client_ca: Path
    runtime_config: Path
    service_uri: str
    max_connection_age: float = Field(gt=0, le=300)

    @field_validator("host")
    @classmethod
    def address(cls, value: str) -> str:
        ipaddress.ip_address(value)
        return value

    @field_validator("service_uri")
    @classmethod
    def service(cls, value: str) -> str:
        uri = urlsplit(value)
        if (
            uri.scheme != "spiffe"
            or not uri.netloc
            or not uri.path
            or uri.query
            or uri.fragment
            or uri.username
            or uri.password
            or any(c.isspace() for c in value)
        ):
            raise ValueError("invalid service URI")
        return value


def protected_file(path: Path, *, private: bool) -> bytes:
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("absolute protected path required")
    for parent in reversed(path.parents):
        info = parent.lstat()
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid not in {0, os.getuid()}
            or info.st_mode & 0o022
        ):
            raise ValueError("unprotected parent directory")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        forbidden = 0o077 if private else 0o022
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid not in {0, os.getuid()}
            or info.st_mode & forbidden
        ):
            raise ValueError("unprotected file")
        return stream.read()


def load(path: Path) -> tuple[ListenerSettings, ssl.SSLContext]:
    if "SSLKEYLOGFILE" in os.environ:
        raise ValueError("TLS key logging is forbidden")
    policy = ListenerSettings.model_validate_json(protected_file(path, private=True))
    runtime = Settings.model_validate_json(
        protected_file(policy.runtime_config, private=True), strict=True
    )
    if (
        runtime.mode != "test"
        or runtime.token_hashes
        or not runtime.task_queue.startswith("finance-")
        or runtime.project_service_token_sha256
        or runtime.project_task_queue
        or runtime.interrupt_after_effect
    ):
        raise ValueError("finance requires an isolated test runtime")
    if runtime.temporal_tls:
        for file, private in [
            (runtime.temporal_tls.ca_path, False),
            (runtime.temporal_tls.certificate_path, False),
            (runtime.temporal_tls.private_key_path, True),
        ]:
            protected_file(file, private=private)
    ca = protected_file(policy.client_ca, private=False)
    protected_file(policy.certificate, private=False)
    protected_file(policy.private_key, private=True)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = context.maximum_version = ssl.TLSVersion.TLSv1_3
    context.verify_mode = ssl.CERT_REQUIRED
    context.load_verify_locations(cadata=ca.decode("ascii"))
    context.load_cert_chain(policy.certificate, policy.private_key)
    context.num_tickets = 0
    context.options |= ssl.OP_NO_TICKET
    context.set_alpn_protocols(["http/1.1"])
    os.environ["BIRBCREW_CONFIG"] = str(policy.runtime_config)
    settings.cache_clear()
    settings()
    return policy, context
