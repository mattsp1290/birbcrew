import asyncio
import os
import signal
from pathlib import Path

from temporalio import activity


async def command(
    argv: list[str], cwd: Path, *, text: str | None = None, timeout=60, subscription=False
) -> str:
    environment = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    if subscription:
        for name in tuple(environment):
            if name.startswith("ANTHROPIC_") or name.startswith("CLAUDE_CODE_USE_"):
                environment.pop(name)
    process = await asyncio.create_subprocess_exec(
        *argv,
        cwd=cwd,
        stdin=asyncio.subprocess.PIPE if text is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
        env=environment,
    )
    try:
        async with asyncio.timeout(timeout):
            pending = asyncio.create_task(
                process.communicate(text.encode() if text is not None else None)
            )
            while not pending.done():
                if activity.in_activity():
                    activity.heartbeat()
                await asyncio.wait({pending}, timeout=1)
            out, _ = pending.result()
    except BaseException:
        if process.returncode is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                os.killpg(process.pid, signal.SIGKILL)
                await process.wait()
        raise
    if process.returncode:
        raise RuntimeError("installed_command_failed")
    if len(out) > 2 * 1024 * 1024:
        raise ValueError("command_output_limit")
    return out.decode()


async def git(config, cwd: Path, *args: str) -> str:
    return (await command([str(config.git), "-c", "core.hooksPath=/dev/null", *args], cwd)).strip()
