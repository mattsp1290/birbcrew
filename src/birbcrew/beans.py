import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

from birbcrew.domain import Note, NoteContext


class FixtureHub:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.hub = self.root / "hub"
        self.env = {
            **{k: v for k, v in os.environ.items() if not k.startswith("GIT_")},
            "XDG_CONFIG_HOME": str(self.root / "config"),
            "XDG_CACHE_HOME": str(self.root / "cache"),
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Birbcrew fixture",
            "GIT_AUTHOR_EMAIL": "fixture@localhost",
            "GIT_COMMITTER_NAME": "Birbcrew fixture",
            "GIT_COMMITTER_EMAIL": "fixture@localhost",
        }
        for key in list(self.env):
            if key.startswith(("BN_", "BEANS_", "GIT_CONFIG_")) and key not in {
                "GIT_CONFIG_GLOBAL",
                "GIT_CONFIG_NOSYSTEM",
            }:
                del self.env[key]

    def git(self, *args: str) -> str:
        return subprocess.check_output(
            ["git", "-C", str(self.hub), *args], env=self.env, text=True
        ).strip()

    def assert_safe(self) -> None:
        if not self.root.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            raise ValueError("Fixture must be inside the temporary directory")
        if not self.hub.resolve().is_relative_to(self.root) or self.hub.is_symlink():
            raise ValueError("Hub escaped fixture root")
        if Path(self.git("rev-parse", "--show-toplevel")).resolve() != self.hub:
            raise ValueError("Resolved hub does not match explicit fixture hub")
        if self.git("remote"):
            raise ValueError("This proof requires a fixture with no remotes")

    def bn(self, project: str, *args: str):
        self.assert_safe()
        command = [
            "bn",
            "--hub",
            str(self.hub),
            "--branch",
            "main",
            "--actor",
            "birbcrew-proof",
            "--project",
            project,
            "--json",
            "--no-fetch",
            "--no-sync",
            *args,
        ]
        return json.loads(subprocess.check_output(command, env=self.env, text=True, cwd=self.root))

    def seed(self) -> None:
        if not self.root.is_relative_to(Path(tempfile.gettempdir()).resolve()):
            raise ValueError("Fixture must be inside the temporary directory")
        self.hub.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", "-b", "main", str(self.hub)], env=self.env, check=True)
        self.git("commit", "--allow-empty", "-qm", "Initialize disposable fixture")
        self.assert_safe()
        self.bn("birbcrew", "project", "create", "birbcrew")
        self.bn(
            "birbcrew",
            "remember",
            "--key",
            "milestone",
            "Use only synthetic work items. Preserve conversation identity across reconnect.",
        )
        self.bn(
            "birbcrew",
            "remember",
            "--key",
            "verification",
            "Recover the committed operation before asking the human to inspect or test.",
        )
        self.bn("unrelated", "project", "create", "unrelated")
        self.bn(
            "unrelated",
            "remember",
            "--key",
            "private-sentinel",
            "UNRELATED_FIXTURE_MUST_NOT_ENTER_CONTEXT",
        )

    def capture(self) -> NoteContext:
        self.assert_safe()
        before = self.git("rev-parse", "HEAD")
        if self.git("status", "--porcelain"):
            raise ValueError("Fixture hub must be clean")
        records = self.bn("birbcrew", "memories", "--limit", "2")
        notes = []
        captured = {}
        for note in records:
            path = (self.hub / note["path"]).resolve()
            if note["project"] != "birbcrew" or not path.is_relative_to(
                self.hub / "projects" / "birbcrew"
            ):
                raise ValueError("Unexpected project note")
            body = path.read_bytes()
            captured[path] = body
            notes.append(
                Note(
                    key=note["key"],
                    path=note["path"],
                    updated=note["updated"],
                    file_sha256=hashlib.sha256(body).hexdigest(),
                    content_sha256=hashlib.sha256(note["body"].encode()).hexdigest(),
                    body=note["body"],
                )
            )
        if self.git("status", "--porcelain") or before != self.git("rev-parse", "HEAD"):
            raise ValueError("Fixture changed during capture")
        if any(path.read_bytes() != content for path, content in captured.items()):
            raise ValueError("Fixture content changed during capture")
        return NoteContext(project="birbcrew", actor="birbcrew-proof", commit=before, notes=notes)
