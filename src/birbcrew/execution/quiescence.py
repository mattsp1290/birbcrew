import asyncio
from hashlib import sha256
from pathlib import Path


def fingerprint(root: Path) -> str:
    value = sha256()
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("unexpected_owned_worktree_symlink")
        if path.is_file():
            value.update(str(path.relative_to(root)).encode())
            value.update(path.read_bytes())
    return value.hexdigest()


async def no_open_handles(binary: Path, work: Path) -> bool:
    process = await asyncio.create_subprocess_exec(
        str(binary),
        "-t",
        "+D",
        str(work),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, error = await asyncio.wait_for(process.communicate(), 10)
    except TimeoutError:
        process.kill()
        await process.wait()
        return False
    return process.returncode == 1 and not out and not error


async def confirmed_quiet(config, work: Path) -> bool:
    before = await asyncio.to_thread(fingerprint, work)
    if not await no_open_handles(config.lsof, work):
        return False
    await asyncio.sleep(1)
    return before == await asyncio.to_thread(fingerprint, work) and await no_open_handles(
        config.lsof, work
    )
