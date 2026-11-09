import os
import re
import stat
from contextlib import ExitStack
from pathlib import Path

SECRET_FORMATS = re.compile(
    rb"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----"
    rb"|\bgh[pousr]_[A-Za-z0-9]{20,}"
    rb"|\bgithub_pat_[A-Za-z0-9_]{20,}"
    rb"|\bsk-(?:ant-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{32,})"
    rb"|\bxox[baprs]-[A-Za-z0-9-]{20,}"
    rb"|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"
    rb"|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
    rb"|AGE-SECRET-KEY-[A-Z0-9]{40,}"
)


def document_bytes(root: Path, name: str) -> bytes:
    with ExitStack() as stack:
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        stack.callback(os.close, directory)
        parts = Path(name).parts
        for part in parts[:-1]:
            directory = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory
            )
            stack.callback(os.close, directory)
        descriptor = os.open(
            parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
        )
        stack.callback(os.close, descriptor)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_mode & 0o111 or before.st_size > 65536:
            raise ValueError("candidate_document_invalid")
        with os.fdopen(os.dup(descriptor), "rb") as stream:
            content = stream.read(65537)
        after = os.fstat(descriptor)
        current = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
        signatures = {
            (
                info.st_dev,
                info.st_ino,
                info.st_mode,
                info.st_size,
                info.st_mtime_ns,
                info.st_ctime_ns,
            )
            for info in (before, after, current)
        }
        if len(signatures) != 1 or len(content) != after.st_size:
            raise ValueError("candidate_changed_during_snapshot")
        content.decode("utf-8")
        if SECRET_FORMATS.search(content):
            raise ValueError("candidate_contains_credential_format")
        return content


def write_document(root: Path, name: str, content: bytes) -> None:
    with ExitStack() as stack:
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        stack.callback(os.close, directory)
        parts = Path(name).parts
        for part in parts[:-1]:
            try:
                os.mkdir(part, dir_fd=directory)
            except FileExistsError:
                pass
            directory = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory
            )
            stack.callback(os.close, directory)
        descriptor = os.open(
            parts[-1],
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW,
            0o644,
            dir_fd=directory,
        )
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
