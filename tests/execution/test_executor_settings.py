import asyncio
import json
import os
import re
from pathlib import Path

import pytest
import test_execution
from pydantic import ValidationError

from birbcrew import provider
from birbcrew.execution import author
from birbcrew.execution import daemon as codex_daemon
from birbcrew.execution.policy import ClaudeReviewer, ExecutionSettings, OpenCodeGoReviewer

setup = test_execution.setup
daemon = test_execution.daemon
ROOT = Path(__file__).parents[2]


def installed(config, **changes):
    raw = config.model_dump(mode="json", exclude={"reviewer", "claude"})
    return ExecutionSettings.model_validate_json(json.dumps(raw | changes))


def test_existing_configuration_keeps_claude_reviewer(setup):
    config, _, _ = setup
    loaded = installed(config, claude="/opt/claude")
    assert loaded.reviewer == ClaudeReviewer(kind="claude")
    assert loaded.claude == Path("/opt/claude")
    assert loaded.codex_socket is None


def test_claude_reviewer_requires_claude_path(setup):
    config, _, _ = setup
    with pytest.raises(ValidationError, match="claude_reviewer_requires_claude_path"):
        installed(config)
    with pytest.raises(ValidationError, match="claude_reviewer_requires_claude_path"):
        installed(config, reviewer={"kind": "claude"})


def test_opencode_reviewer_needs_no_claude_and_rejects_one(setup):
    config, _, _ = setup
    reviewer = {"kind": "opencode-go", "subscription_evidence": "/private/go-evidence.json"}
    loaded = installed(config, reviewer=reviewer)
    assert loaded.reviewer == OpenCodeGoReviewer(
        kind="opencode-go", subscription_evidence=Path("/private/go-evidence.json")
    )
    assert loaded.claude is None and loaded.reviewer.api_key_file is None
    with pytest.raises(ValidationError, match="claude_path_requires_claude_reviewer"):
        installed(config, reviewer=reviewer, claude="/opt/claude")


@pytest.mark.parametrize(
    "reviewer",
    [
        {"kind": "opencode-go"},
        {"kind": "opencode"},
        {"kind": "claude", "subscription_evidence": "/private/go-evidence.json"},
        {"kind": "opencode-go", "subscription_evidence": "/e.json", "fallback": "claude"},
        "opencode-go",
    ],
)
def test_reviewer_selection_rejects_illegal_shapes(setup, reviewer):
    config, _, _ = setup
    with pytest.raises(ValidationError):
        installed(config, reviewer=reviewer, claude="/opt/claude")
    with pytest.raises(ValidationError):
        installed(config, reviewer=reviewer)


@pytest.mark.parametrize(
    "changes",
    [
        {"reviewer": {"kind": "opencode-go", "subscription_evidence": "evidence.json"}},
        {
            "reviewer": {
                "kind": "opencode-go",
                "subscription_evidence": "/private/evidence.json",
                "api_key_file": "go.key",
            }
        },
        {"claude": "claude"},
        {"claude": "/opt/claude", "codex_socket": "codex.sock"},
    ],
)
def test_configured_paths_must_be_absolute(setup, changes):
    config, _, _ = setup
    with pytest.raises(ValidationError, match="installation_requires_absolute_paths"):
        installed(config, **changes)


def write_key(path, text, mode=0o600):
    path.write_text(text)
    path.chmod(mode)
    return path


@pytest.mark.parametrize("text", ["token-1\n", "token-1", "sk-abc_DEF.123=\n"])
def test_key_file_accepts_one_private_token(tmp_path, text):
    path = write_key(tmp_path / "key", text)
    assert provider.read_key_file(path) == text.strip()


@pytest.mark.parametrize("mode", [0o640, 0o604, 0o620, 0o602, 0o610, 0o601, 0o644])
def test_key_file_rejects_group_or_other_bits(tmp_path, mode):
    path = write_key(tmp_path / "key", "token-1\n", mode)
    with pytest.raises(ValueError, match="private to this user"):
        provider.read_key_file(path)


@pytest.mark.parametrize("text", ["", "\n", "two tokens\n", "token\nsecond\n", "token\n\n", " t"])
def test_key_file_requires_exactly_one_token(tmp_path, text):
    path = write_key(tmp_path / "key", text)
    with pytest.raises(ValueError, match="one token"):
        provider.read_key_file(path)


def test_key_file_rejects_oversize_symlink_directory_fifo_and_other_owner(tmp_path, monkeypatch):
    big = write_key(tmp_path / "big", "a" * 4097)
    with pytest.raises(ValueError, match="one token"):
        provider.read_key_file(big)
    target = write_key(tmp_path / "target", "token-1\n")
    (tmp_path / "link").symlink_to(target)
    with pytest.raises(OSError):
        provider.read_key_file(tmp_path / "link")
    (tmp_path / "directory").mkdir(mode=0o700)
    with pytest.raises(ValueError, match="private to this user"):
        provider.read_key_file(tmp_path / "directory")
    os.mkfifo(tmp_path / "fifo", 0o600)
    with pytest.raises(ValueError, match="private to this user"):
        provider.read_key_file(tmp_path / "fifo")
    other = os.geteuid() + 1
    monkeypatch.setattr(provider.os, "geteuid", lambda: other)
    with pytest.raises(ValueError, match="private to this user"):
        provider.read_key_file(target)


def test_profile_key_reader_still_supports_existing_installations(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / ".profile").write_text("export PATH=/bin\nexport OPENCODE_GO_API_KEY='fixture-1'\n")
    assert provider.read_go_key() == "fixture-1"


@pytest.mark.parametrize(
    "socket,expected",
    [
        (None, ["/opt/codex", "app-server", "proxy"]),
        (
            Path("/var/run/codex/app-server-control.sock"),
            [
                "/opt/codex",
                "app-server",
                "proxy",
                "--sock",
                "/var/run/codex/app-server-control.sock",
            ],
        ),
    ],
)
def test_codex_socket_reaches_proxy_argv(monkeypatch, socket, expected):
    started = []

    async def exec_(*argv, **kwargs):
        started.append(list(argv))
        raise ConnectionError("fixture stops before the handshake")

    monkeypatch.setattr(codex_daemon.asyncio, "create_subprocess_exec", exec_)

    async def connect():
        async with codex_daemon.Daemon(Path("/opt/codex"), socket):
            pass

    with pytest.raises(ConnectionError):
        asyncio.run(connect())
    assert started == [expected]


def test_author_uses_configured_codex_socket(setup, daemon, monkeypatch):
    config, request, _ = setup
    socket = Path("/shared/codex/app-server-control.sock")
    config = installed(config, claude="/opt/claude", codex_socket=str(socket))
    monkeypatch.setattr(author, "installation", lambda: config)
    clients = []

    class Recording(daemon):
        def __init__(self, *args):
            clients.append(args)

    monkeypatch.setattr(author, "Daemon", Recording)
    result = asyncio.run(author.author_goal(request.model_dump(mode="json")))
    assert result["status"] == "candidate"
    assert clients and all(args == (config.codex, socket) for args in clients)


def test_executor_image_pins_the_locked_codex_packages():
    lock = json.loads((ROOT / "package-lock.json").read_text())["packages"]
    dockerfile = (ROOT / "packaging/executor.Dockerfile").read_text()
    version = lock["node_modules/@openai/codex"]["version"]
    for platform in ("linux-x64", "linux-arm64"):
        locked = lock[f"node_modules/@openai/codex-{platform}"]
        assert locked["version"] == f"{version}-{platform}"
        assert locked["resolved"].endswith(f"/codex-{version}-{platform}.tgz")
        assert re.search(
            rf"set -- {platform} \S+ {re.escape(locked['integrity'].removeprefix('sha512-'))} ;;",
            dockerfile,
        )
    assert f"/codex-{version}-$platform.tgz" in dockerfile
