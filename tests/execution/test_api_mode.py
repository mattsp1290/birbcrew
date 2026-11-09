import asyncio
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from birbcrew import api
from birbcrew.domain import CreateConversation, NoteContext, Prompt


def test_approved_goal_creates_owned_conversation_without_model_workflow(monkeypatch):
    context = NoteContext(project="factory", actor="owner", commit="a" * 40, notes=[])
    config = SimpleNamespace(mode="approved-goal", context=context)
    values = {}

    async def create(state):
        values[state.id] = state.model_dump(mode="json")
        return True

    async def snapshot(cid, principal):
        row = values.get(cid)
        return {**row, "cursor": 0} if row and row["owner"] == principal else None

    class NoWorkflow:
        async def start_workflow(self, *args, **kwargs):
            raise AssertionError("approved goal must not start synthetic model workflow")

    monkeypatch.setattr(api, "settings", lambda: config)
    monkeypatch.setattr(api.store, "create", create)
    monkeypatch.setattr(api.store, "snapshot", snapshot)
    monkeypatch.setattr(api.app.state, "temporal", NoWorkflow(), raising=False)
    cid = uuid4()
    result = asyncio.run(api.create(CreateConversation(id=cid), "owner"))
    assert result["mode"] == "approved-goal"
    assert asyncio.run(api.get_state(cid, "owner"))["mode"] == "approved-goal"
    with pytest.raises(HTTPException) as denied:
        asyncio.run(api.get_state(cid, "other"))
    assert denied.value.status_code == 404
    with pytest.raises(HTTPException) as synthetic:
        asyncio.run(api.submit(cid, Prompt(request_id=uuid4(), text="dispatch"), "owner"))
    assert synthetic.value.status_code == 409
