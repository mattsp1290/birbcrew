from enum import StrEnum
from hashlib import sha256
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Coworker(Record):
    id: str = "birbcrew-proof"
    version: int = 1
    instructions: str = (
        "You are a coding coworker testing a disposable repository. Read the supplied project "
        "notes. Record one synthetic coding work item with record_work_item, then request "
        "a human next step with choose_next_step. After the human reply, summarize the "
        "recorded item and the choice. Do not repeat the completed operation. No real actions."
    )
    eligible_models: list[str] = ["test", "glm-5.3-flash"]
    tools: list[str] = ["record_work_item", "choose_next_step"]


class Note(Record):
    key: str
    path: str
    updated: dict[str, int]
    file_sha256: str
    content_sha256: str
    body: str


class NoteContext(Record):
    project: str
    actor: str
    commit: str
    notes: list[Note]


class Phase(StrEnum):
    IDLE = "idle"
    RUNNING = "running"
    WAITING = "waiting"
    CANCELLED = "cancelled"
    FAILED = "failed"


class Prompt(Record):
    request_id: UUID
    text: str = Field(min_length=1, max_length=4000)

    @property
    def digest(self) -> str:
        return sha256(self.text.encode()).hexdigest()


class AcceptedInput(Record):
    request_id: str
    digest: str
    text: str
    ordinal: int
    outcome: Literal["accepted", "running", "waiting", "completed", "cancelled", "failed"]


class HumanRequest(Record):
    id: str
    version: int = 1
    expected_responder: str
    tool_call_id: str
    resolution: Literal["inspect", "test"] | None = None


class HumanReply(Record):
    request_id: str
    version: int
    choice: Literal["inspect", "test"]


class Resolution(HumanReply):
    actor: str


class RunAttempt(Record):
    id: str
    workflow_id: str
    workflow_run_id: str
    request_id: str
    outcome: str


class Conversation(Record):
    id: str
    owner: str
    coworker: Coworker = Field(default_factory=Coworker)
    context: NoteContext
    phase: Phase = Phase.IDLE
    revision: int = 0
    inputs: list[AcceptedInput] = Field(default_factory=list)
    attempts: list[RunAttempt] = Field(default_factory=list)
    human: HumanRequest | None = None
    decisions: list[HumanRequest] = Field(default_factory=list)
    native_messages: list[dict[str, Any]] = Field(default_factory=list)
    messages: list[dict[str, Any]] = Field(default_factory=list)
    failure: str | None = None


class RunDeps(Record):
    run_id: str
    conversation_id: str
    request_id: str
    operation_id: str
    text: str
    interrupt_after_effect: bool = False


class Projection(Record):
    conversation_id: str
    workflow_id: str
    run_id: str
    offset: int


class CreateConversation(Record):
    id: UUID


def workflow_id(conversation_id: str) -> str:
    return f"birbcrew-{conversation_id}"
