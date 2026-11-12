import json
import os
import re
import stat
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from openai import AsyncOpenAI
from pydantic import AwareDatetime, BaseModel, ConfigDict
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

ENDPOINT = "https://opencode.ai/inference/go/openai/v1"
MODEL = "glm-5.3-flash"


class SubscriptionEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: str
    account_path: str
    extra_usage_disabled: bool
    eligible_coding_use: bool
    checked_at: AwareDatetime
    evidence: str


def check_evidence(path: Path) -> SubscriptionEvidence:
    evidence = SubscriptionEvidence.model_validate_json(path.read_text())
    if evidence.provider != "opencode-go" or not evidence.account_path:
        raise ValueError("An identified OpenCode Go subscription is required")
    if not evidence.extra_usage_disabled or not evidence.eligible_coding_use:
        raise ValueError(
            "Live calls blocked. Owner must verify eligibility and disable Extra Usage."
        )
    age = datetime.now(UTC) - evidence.checked_at
    if age < timedelta(0) or age > timedelta(hours=12) or not evidence.evidence:
        raise ValueError("Current account-setting evidence is required before live calls")
    return evidence


def read_go_key() -> str:
    text = (Path.home() / ".profile").read_text()
    match = re.search(
        r"^\s*(?:export\s+)?OPENCODE_GO_API_KEY=([\'\"]?)([^\s\'\"$`]+)\1\s*$",
        text,
        flags=re.MULTILINE,
    )
    if not match:
        raise ValueError("No literal OPENCODE_GO_API_KEY assignment in ~/.profile")
    return match[2]


def read_key_file(path: Path) -> str:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_mode & (stat.S_IRWXG | stat.S_IRWXO)
        ):
            raise ValueError("OpenCode Go key file must be private to this user")
        data = b""
        while len(data) <= 4096 and (chunk := os.read(descriptor, 4097 - len(data))):
            data += chunk
    finally:
        os.close(descriptor)
    match = re.fullmatch(rb"([\x21-\x7e]{1,4096})\n?", data)
    if not match:
        raise ValueError("OpenCode Go key file must contain one token")
    return match[1].decode()


def go_client(api_key: str) -> AsyncOpenAI:
    return AsyncOpenAI(base_url=ENDPOINT, api_key=api_key, max_retries=0)


def chat_model(client: AsyncOpenAI) -> OpenAIChatModel:
    return OpenAIChatModel(MODEL, provider=OpenAIProvider(openai_client=client))


def model(evidence_path: Path) -> OpenAIChatModel:
    check_evidence(evidence_path)
    return chat_model(go_client(read_go_key()))


def model_settings(cid: str) -> dict:
    return {
        "extra_headers": {"User-Agent": "birbcrew-coding-proof/0.1.0", "x-opencode-session": cid},
        "max_tokens": 1200,
    }


def review_model_settings(session: str) -> dict:
    return {
        "extra_headers": {"User-Agent": "birbcrew-review/0.1.0", "x-opencode-session": session},
        "max_tokens": 8192,
        "timeout": 600,
    }


def project_model_settings(cid: str) -> dict:
    return {
        "extra_headers": {"User-Agent": "birbcrew-project-chat/0.1.0", "x-opencode-session": cid},
        "max_tokens": 4096,
    }


def evidence_summary(path: Path) -> dict:
    evidence = check_evidence(path)
    read_go_key()
    return {
        **json.loads(evidence.model_dump_json()),
        "endpoint": ENDPOINT,
        "model": MODEL,
        "credential_present": True,
        "credential_source": "~/.profile",
        "usage_visibility": "Owner attestation of console settings. No billing API verified.",
    }


def preflight_account(path: Path) -> dict:
    summary = evidence_summary(path)
    response = httpx.get(
        ENDPOINT + "/models",
        headers={
            "Authorization": "Bearer " + read_go_key(),
            "User-Agent": "birbcrew-coding-proof/0.1.0",
            "x-opencode-session": "birbcrew-preflight",
        },
        timeout=20,
        follow_redirects=False,
    )
    if response.status_code != 200:
        raise ValueError(
            f"Live calls blocked. Go credential preflight returned HTTP {response.status_code}."
        )
    if MODEL not in {item.get("id") for item in response.json().get("data", [])}:
        raise ValueError("Live calls blocked. Selected model is not listed for this credential.")
    return summary | {"models_http_status": 200, "selected_model_listed": True}
