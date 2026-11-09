import asyncio
import json
import os
import signal
import stat
from hashlib import sha256
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


def worktree_record(config, work: Path) -> Path:
    return config.artifact_root / f"git-{sha256(str(work).encode()).hexdigest()}.json"


def git_marker(work: Path) -> bytes:
    descriptor = os.open(work / ".git", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("worktree_git_marker_invalid")
        marker = stream.read(8193)
    if len(marker) > 8192:
        raise ValueError("worktree_git_marker_invalid")
    return marker


async def register_worktree(config, work: Path) -> None:
    marker = git_marker(work)
    common = Path(await git(config, config.repository.checkout, "rev-parse", "--git-common-dir"))
    if not common.is_absolute():
        common = config.repository.checkout / common
    git_dir = Path(marker.decode().removeprefix("gitdir: ").rstrip("\n"))
    if not git_dir.is_absolute() or git_dir.parent.resolve() != (common / "worktrees").resolve():
        raise ValueError("worktree_git_directory_invalid")
    config.artifact_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    record = {"git_dir": str(git_dir), "marker": marker.decode()}
    with os.fdopen(
        os.open(worktree_record(config, work), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
    ) as stream:
        json.dump(record, stream)


async def git_output(config, cwd: Path, *args: str) -> str:
    options = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]
    if cwd != config.repository.checkout:
        record = json.loads(worktree_record(config, cwd).read_text())
        if git_marker(cwd) != record["marker"].encode():
            raise ValueError("worktree_git_identity_changed")
        options.extend([f"--git-dir={record['git_dir']}", f"--work-tree={cwd}"])
    return await command([str(config.git), *options, *args], config.repository.checkout)


async def git(config, cwd: Path, *args: str) -> str:
    return (await git_output(config, cwd, *args)).rstrip("\n")
