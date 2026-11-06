import asyncio
import json
from uuid import NAMESPACE_URL, uuid5

from pydantic_ai.messages import ModelRequest, ModelResponse, UserPromptPart
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, FunctionModel


async def coding_fixture(messages, info: AgentInfo):
    assert info.instructions and "Selected repository notes" in info.instructions
    assert "UNRELATED_FIXTURE" not in info.instructions
    start = max(
        i
        for i, message in enumerate(messages)
        if isinstance(message, ModelRequest)
        and any(isinstance(part, UserPromptPart) for part in message.parts)
    )
    if not any(isinstance(message, ModelResponse) for message in messages[start:]):
        record = next(tool for tool in info.function_tools if tool.name == "record_work_item")
        operation_id = record.parameters_json_schema["properties"]["operation_id"]["enum"][0]
        yield {
            0: DeltaToolCall(
                name="record_work_item",
                json_args=json.dumps({"operation_id": operation_id}),
                tool_call_id=str(uuid5(NAMESPACE_URL, operation_id + "/record")),
            ),
            1: DeltaToolCall(
                name="choose_next_step",
                json_args="{}",
                tool_call_id=str(uuid5(NAMESPACE_URL, operation_id + "/human")),
            ),
        }
    else:
        for text in [
            "The scoped repository notes require ",
            "synthetic work only. ",
            "The work item and human next step are recorded.",
        ]:
            yield text
            await asyncio.sleep(0.3)


def model():
    return FunctionModel(stream_function=coding_fixture, model_name="birbcrew-coding-fixture-v1")
