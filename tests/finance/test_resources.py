import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from resources import Container, QualificationRun


class Child:
    pid = 501

    def __init__(self, fault=None):
        self.fault = fault
        self.dead = False

    def poll(self):
        if self.fault == "poll":
            raise OSError("injected poll")
        return 0 if self.dead else None

    def terminate(self):
        if self.fault == "terminate":
            raise OSError("injected terminate")
        if self.fault not in {"wait", "kill", "survivor"}:
            self.dead = True

    def kill(self):
        if self.fault == "kill":
            raise OSError("injected kill")
        if self.fault != "survivor":
            self.dead = True

    def wait(self, timeout):
        if not self.dead or self.fault == "wait":
            raise subprocess.TimeoutExpired("child", timeout)
        return 0


class ResourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.owner = QualificationRun(self.root, self.root, timeout=0.1, reconcile_seconds=0.15)
        self.owner.telemetry = lambda: {"test": "cleanup-only"}
        self.owner.source_hashes = lambda: {}
        self.addCleanup(self.temporary.cleanup)

    def record(self, label):
        evidence = os.environ.get("FINANCE_RESOURCE_EVIDENCE")
        if evidence:
            path = Path(evidence)
            path.mkdir(exist_ok=True)
            (path / f"{label}.json").write_text(json.dumps(self.owner.ledger, indent=2))

    def matrix(self, fault):
        owner = self.owner
        ids = [char * 64 for char in "abc"]
        owner.containers = [
            Container(f"owned-{i}", "token", self.root / str(i), role, identifier)
            for i, (identifier, role) in enumerate(zip(ids, ["listener", "listener", "database"]))
        ]
        owner.children = [Child(fault)]
        remaining = set(ids)
        calls = []

        def command(argv, **kwargs):
            calls.append(argv)
            operation = argv[1]
            selected = argv[-1].removeprefix("id=")
            if operation == "container":
                if fault == "malformed":
                    return subprocess.CompletedProcess(argv, 0, "bad-id\n", "")
                if fault == "unobservable":
                    raise OSError("daemon unavailable")
                output = selected + "\n" if selected in remaining else ""
                return subprocess.CompletedProcess(argv, 0, output, "")
            if operation == "stop":
                if (fault == "first_stop_timeout" and selected == ids[0]) or (
                    fault == "later_stop_timeout" and selected == ids[1]
                ):
                    raise subprocess.TimeoutExpired(argv, kwargs["timeout"])
                if fault == "nonzero" and selected == ids[0]:
                    return subprocess.CompletedProcess(argv, 9, "", "injected nonzero")
            if operation == "rm":
                if fault == "database_remove" and selected == ids[2]:
                    raise OSError("database removal failed")
                if fault != "survivor":
                    remaining.discard(selected)
            return subprocess.CompletedProcess(argv, 0, "", "")

        if fault == "fatal":
            owner.ledger["fatal"] = {"error": "original fatal"}
        owner.ledger["cases"] = [{"status": "fail" if fault == "case" else "pass"}]
        if fault in {"hash", "telemetry"}:

            def broken():
                raise OSError("injected evidence failure")

            if fault == "hash":
                owner.source_hashes = broken
            else:
                owner.telemetry = broken
        if fault == "save":

            def broken_save():
                raise OSError("injected final write")

            owner.save = broken_save
        error_output = io.StringIO()
        with patch("resources.subprocess.run", side_effect=command):
            with contextlib.redirect_stderr(error_output):
                result = owner.finish()
            total = len(calls)
            self.assertIs(owner.finish(), result)
            self.assertEqual(len(calls), total)
        self.assertEqual(result.exit_code, int(fault != "normal"))
        self.assertEqual(owner.ledger["exit_code"], result.exit_code)
        self.assertEqual(len(result.outcomes), 4)
        self.assertEqual(result.outcomes[-1].identity, ids[-1])
        self.assertTrue(any(c[1] == "rm" and c[-1] == ids[-1] for c in calls))
        if fault == "save":
            self.assertEqual(
                json.loads(error_output.getvalue()), json.loads(json.dumps(owner.ledger))
            )
            self.assertIsNotNone(result.ledger_error)
        else:
            self.assertEqual(
                json.loads((self.root / "ledger.json").read_text()),
                json.loads(json.dumps(owner.ledger)),
            )
        if fault == "fatal":
            self.assertEqual(owner.ledger["fatal"], {"error": "original fatal"})
        if fault == "case":
            self.assertEqual(owner.ledger["cases"], [{"status": "fail"}])
        if fault == "malformed":
            self.assertEqual(result.outcomes[0].absence, "unobservable")
        if fault in {"first_stop_timeout", "later_stop_timeout", "nonzero"}:
            self.assertTrue(any(o.errors and o.absence == "absent" for o in result.outcomes))
        self.record(fault)

    def test_cleanup_matrix(self):
        for fault in [
            "normal",
            "first_stop_timeout",
            "later_stop_timeout",
            "nonzero",
            "malformed",
            "terminate",
            "wait",
            "kill",
            "poll",
            "database_remove",
            "unobservable",
            "survivor",
            "fatal",
            "case",
            "hash",
            "telemetry",
            "save",
        ]:
            with self.subTest(fault=fault):
                self.owner.completion = None
                self.owner.ledger = {"cases": [], "commands": []}
                self.owner.telemetry = lambda: {"test": "cleanup-only"}
                self.owner.source_hashes = lambda: {}
                self.owner.save = QualificationRun.save.__get__(self.owner)
                self.matrix(fault)

    def test_already_absent_and_original_reaped_handle(self):
        identifier = "d" * 64
        self.owner.containers.append(
            Container("owned", "token", self.root / "cid", "utility", identifier)
        )
        child = self.owner.spawn([sys.executable, "-I", "-B", "-c", "pass"])
        self.assertEqual(child.wait(timeout=5), 0)
        with patch.object(child, "terminate", side_effect=AssertionError("must not signal")):
            with patch(
                "resources.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "", "")
            ):
                result = self.owner.finish()
        self.assertEqual(result.exit_code, 0)
        self.assertTrue(all(o.absence == "absent" for o in result.outcomes))
        self.assertFalse(Path("/proc", str(child.pid)).exists())
        self.record("already_absent_reaped")

    def test_real_child_escalation(self):
        child = self.owner.spawn(
            [
                sys.executable,
                "-I",
                "-B",
                "-u",
                "-c",
                "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                "print('ready',flush=True); time.sleep(30)",
            ]
        )
        try:
            for _ in range(100):
                if "ready" in child.evidence_log.read_text():
                    break
                time.sleep(0.01)
            else:
                self.fail("child never ready")
            result = self.owner.finish()
            self.assertEqual(result.exit_code, 1)
            self.assertEqual(child.returncode, -9)
            self.assertFalse(Path("/proc", str(child.pid)).exists())
            self.record("real_child_escalation")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)

    def test_pending_receipts(self):
        for fault in [
            "late_cid",
            "missing_cid",
            "wrong_label",
            "malformed_cid",
            "malformed_inspect",
            "collision",
            "unreachable",
        ]:
            with self.subTest(fault=fault):
                self.owner.completion = None
                self.owner.ledger = {"cases": [], "commands": []}
                receipt = Container(
                    "exact-owned",
                    "token",
                    self.root / "cid",
                    "utility",
                    errors=["create timed out"],
                )
                self.owner.containers = [receipt]
                receipt.cidfile.unlink(missing_ok=True)
                identifier = "e" * 64
                calls = []
                removed = False
                attempts = 0

                def command(argv, **kwargs):
                    nonlocal removed, attempts
                    calls.append(argv)
                    if argv[1] == "inspect":
                        attempts += 1
                        if fault == "unreachable" or (fault == "late_cid" and attempts == 1):
                            if fault == "late_cid":
                                receipt.cidfile.write_text(identifier)
                            raise OSError("receipt not visible")
                        if fault == "malformed_cid":
                            receipt.cidfile.write_text("short")
                            raise OSError("receipt not visible")
                        record = {
                            "Id": identifier,
                            "Name": "/" + receipt.name,
                            "Config": {"Labels": {self.owner.label: receipt.token}},
                        }
                        if fault in {"wrong_label", "collision"}:
                            record["Config"]["Labels"][self.owner.label] = "foreign"
                        if fault == "malformed_inspect":
                            record["Id"] = "short"
                        return json.dumps([record])
                    if argv[1] == "container":
                        return "" if removed else identifier + "\n"
                    if argv[1] == "rm":
                        removed = True
                    return ""

                with patch.object(self.owner, "command", side_effect=command):
                    result = self.owner.finish()
                self.assertEqual(result.exit_code, 1)
                row = result.outcomes[0]
                if fault in {"late_cid", "missing_cid"}:
                    self.assertEqual(row.absence, "absent")
                    self.assertEqual(row.identity, identifier)
                else:
                    self.assertEqual(row.absence, "unobservable")
                    self.assertFalse(any(c[1] in {"stop", "rm"} for c in calls))
                self.assertEqual(
                    json.loads((self.root / "ledger.json").read_text())["exit_code"], 1
                )
                self.record(fault)

    def test_telemetry_controls(self):
        child = self.owner.spawn([sys.executable, "-I", "-B", "-c", "pass"])
        child.wait(timeout=5)
        self.owner.worker = child
        self.owner.expected_threads = {"synthetic-thread"}
        self.owner.telemetry = QualificationRun.telemetry.__get__(self.owner)
        output = self.owner.worker_evidence / f"telemetry-{child.pid}.jsonl"
        row = {
            "name": "conversation.persist",
            "trace_id": "a" * 32,
            "span_id": "b" * 16,
            "attributes": {
                "birbcrew.conversation_id": "synthetic-thread",
                "birbcrew.workflow_id": "birbcrew-synthetic-thread",
            },
        }
        for fault in ["missing", "empty", "wrong_thread", "exporter_error", "normal"]:
            with self.subTest(fault=fault):
                self.owner.completion = None
                self.owner.ledger = {"cases": [], "commands": []}
                output.unlink(missing_ok=True)
                child.evidence_log.write_text("")
                if fault != "missing":
                    value = (
                        json.dumps(row).replace("synthetic-thread", "foreign")
                        if (fault == "wrong_thread")
                        else json.dumps(row)
                    )
                    output.write_text("" if fault == "empty" else value + "\n")
                if fault == "exporter_error":
                    child.evidence_log.write_text("Exception while exporting Span\nTraceback\n")
                result = self.owner.finish()
                self.assertEqual(result.exit_code, int(fault != "normal"))
                self.assertEqual(bool(self.owner.ledger["evidence_errors"]), fault != "normal")
                self.record("telemetry_" + fault)

    @unittest.skipUnless(os.environ.get("FINANCE_TEST_DOCKER_IMAGE"), "actual Docker opt-in")
    def test_actual_name_collision_and_unreachable_daemon(self):
        image = os.environ["FINANCE_TEST_DOCKER_IMAGE"]
        self.owner.timeout = 3
        foreign_id = self.owner._create(["--network", "none", image], "utility")
        foreign = self.owner.containers[0]
        collision_root = self.root / "collision"
        collision_root.mkdir()
        collision = QualificationRun(collision_root, self.root, timeout=3, reconcile_seconds=0.1)
        collision.telemetry = lambda: {"test": "collision-only"}
        collision.source_hashes = lambda: {}
        try:
            with patch("resources.uuid4") as generate:
                generate.return_value.hex = foreign.name.removeprefix("crew-finance-")
                with self.assertRaises(RuntimeError):
                    collision.utility(["--network", "none", image])
            result = collision.finish()
            self.assertEqual(result.exit_code, 1)
            self.assertEqual(result.outcomes[0].absence, "unobservable")
            actual = json.loads(self.owner.command(["docker", "inspect", foreign_id]))[0]
            self.assertEqual(actual["Config"]["Labels"][self.owner.label], foreign.token)
            self.assertFalse(
                any(row["argv"][1] in {"stop", "rm"} for row in collision.ledger["commands"])
            )
            previous = self.owner
            self.owner = collision
            self.record("actual_name_collision")
            self.owner = previous
        finally:
            result = self.owner.finish()
            self.assertEqual(result.exit_code, 0)
            self.assertFalse(self.owner._listed(foreign_id))
            self.record("actual_collision_owner_cleanup")
        unreachable_root = self.root / "unreachable"
        unreachable_root.mkdir()
        unreachable = QualificationRun(
            unreachable_root, self.root, timeout=0.5, reconcile_seconds=0.1
        )
        unreachable.telemetry = lambda: {"test": "unreachable-only"}
        unreachable.source_hashes = lambda: {}
        with patch.dict(os.environ, {"DOCKER_HOST": "unix:///nonexistent-finance-proof.sock"}):
            with self.assertRaises(RuntimeError):
                unreachable.utility(["--network", "none", image])
            result = unreachable.finish()
        self.assertEqual(result.exit_code, 1)
        self.assertEqual(result.outcomes[0].absence, "unobservable")
        self.owner = unreachable
        self.record("actual_unreachable_daemon")

    @unittest.skipUnless(os.environ.get("FINANCE_TEST_DOCKER_IMAGE"), "actual Docker opt-in")
    def test_actual_docker_create_timeout(self):
        real_docker = shutil.which("docker")
        shim = self.root / "docker"
        shim.write_text(
            f"#!{sys.executable}\n"
            "import os,pathlib,subprocess,sys,time\n"
            f"real={real_docker!r}\n"
            f"root=pathlib.Path({str(self.root)!r})\n"
            "if sys.argv[1]=='create':\n"
            " p=pathlib.Path(sys.argv[sys.argv.index('--cidfile')+1])\n"
            " result=subprocess.run([real,*sys.argv[1:]],capture_output=True,text=True)\n"
            " if result.returncode: sys.exit(result.returncode)\n"
            " p.rename(root/'delayed.cid')\n"
            " (root/'accepted').write_text(result.stdout)\n"
            " time.sleep(30)\n"
            "elif sys.argv[1]=='inspect' and not (root/'release').exists():\n"
            " sys.exit(9)\n"
            "else: os.execv(real,[real,*sys.argv[1:]])\n"
        )
        shim.chmod(0o700)
        for role in ["utility", "service"]:
            with self.subTest(role=role):
                directory = self.root / role
                directory.mkdir()
                owner = QualificationRun(directory, directory, timeout=0.8, reconcile_seconds=3)
                owner.telemetry = lambda: {"test": "acquisition-only"}
                owner.source_hashes = lambda: {}
                for filename in ["release", "accepted", "delayed.cid"]:
                    (self.root / filename).unlink(missing_ok=True)
                options = [
                    "--network",
                    "none",
                    os.environ["FINANCE_TEST_DOCKER_IMAGE"],
                    "python",
                    "-I",
                    "-B",
                    "-c",
                    "pass",
                ]
                verified = None
                try:
                    with patch.dict(
                        os.environ, {"PATH": str(self.root) + ":" + os.environ["PATH"]}
                    ):
                        with self.assertRaises(subprocess.TimeoutExpired):
                            getattr(owner, role)(options)
                        accepted = (self.root / "accepted").read_text().strip()
                        self.assertRegex(accepted, r"^[a-f0-9]{64}$")
                        actual = json.loads(
                            subprocess.check_output(
                                [real_docker, "inspect", accepted], text=True, timeout=5
                            )
                        )[0]
                        receipt = owner.containers[0]
                        self.assertEqual(actual["Config"]["Labels"][owner.label], receipt.token)
                        verified = accepted
                        self.assertFalse(receipt.cidfile.exists())
                        owner.ledger["timeout_control"] = {
                            "daemon_accepted_id": accepted,
                            "label_verified": True,
                            "cidfile_initially_absent": True,
                            "role": role,
                        }

                        def release():
                            time.sleep(0.25)
                            (self.root / "delayed.cid").replace(receipt.cidfile)
                            (self.root / "release").touch()

                        thread = threading.Thread(target=release)
                        thread.start()
                        result = owner.finish()
                        thread.join(timeout=5)
                    self.assertEqual(result.exit_code, 1)
                    self.assertEqual(result.outcomes[0].identity, accepted)
                    self.assertEqual(result.outcomes[0].absence, "absent")
                    listed = subprocess.check_output(
                        [
                            real_docker,
                            "container",
                            "ls",
                            "-a",
                            "--no-trunc",
                            "--format",
                            "{{.ID}}",
                            "--filter",
                            "id=" + accepted,
                        ],
                        text=True,
                        timeout=5,
                    )
                    self.assertEqual(listed, "")
                    previous = self.owner
                    self.owner = owner
                    self.record("actual_create_timeout_" + role)
                    self.owner = previous
                finally:
                    if verified:
                        subprocess.run(
                            [real_docker, "rm", "--force", verified],
                            capture_output=True,
                            timeout=5,
                        )


if __name__ == "__main__":
    unittest.main()
