import json
import os
from functools import cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict

from birbcrew.domain import NoteContext


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    database_url: str
    temporal_address: str
    task_queue: str
    token_hashes: dict[str, str]
    context: NoteContext
    evidence_dir: Path
    mode: str = "test"
    interrupt_after_effect: bool = False
    live_attestation: Path | None = None


@cache
def settings() -> Settings:
    return Settings.model_validate_json(Path(os.environ["BIRBCREW_CONFIG"]).read_text())


def write_private(path: Path, data: dict) -> None:
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump(data, f, indent=2)
