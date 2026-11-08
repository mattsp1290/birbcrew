import asyncio
import json
import sys
from pathlib import Path

from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.client import WorkflowHistory
from temporalio.worker import Replayer

from birbcrew.config import settings
from birbcrew.telemetry import configure


async def replay(paths: list[Path]) -> list[dict]:
    settings().evidence_dir = settings().evidence_dir / "offline-replay-telemetry"
    settings().evidence_dir.mkdir(exist_ok=True)
    configure()
    from birbcrew.workflow import ConversationWorkflow

    replayer = Replayer(workflows=[ConversationWorkflow], plugins=[PydanticAIPlugin()])
    results = []
    for path in paths:
        history = WorkflowHistory.from_json(
            f"birbcrew-{path.name.removesuffix('-history.json')}", path.read_text()
        )
        await replayer.replay_workflow(history)
        results.append({"workflow_id": history.workflow_id, "replay": "VERIFIED"})
    return results


if __name__ == "__main__":
    print(json.dumps(asyncio.run(replay([Path(p) for p in sys.argv[1:]])), indent=2))
