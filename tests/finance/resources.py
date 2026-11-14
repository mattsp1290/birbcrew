import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from uuid import uuid4


@dataclass(frozen=True)
class Outcome:
    kind: str
    identity: str
    absence: str
    errors: tuple[str, ...]

    @property
    def ok(self):
        return self.absence == "absent" and not self.errors


@dataclass(frozen=True)
class Completion:
    outcomes: tuple[Outcome, ...]
    ledger_error: str | None
    exit_code: int


@dataclass
class Container:
    name: str
    token: str
    cidfile: Path
    role: str
    identifier: str | None = None
    errors: list[str] = field(default_factory=list)


class QualificationRun:
    label = "birbcrew.finance.qualifier"

    def __init__(self, root, source, *, timeout=5, reconcile_seconds=3):
        self.root = root
        self.source = source
        self.timeout = timeout
        self.reconcile_seconds = reconcile_seconds
        self.ledger = {"cases": [], "commands": [], "cleanup": [], "versions": {}}
        self.children = []
        self.containers = []
        self.worker = None
        self.expected_threads = set()
        self.completion = None
        (root / "receipts").mkdir(mode=0o700)
        self.worker_evidence = root / "worker-evidence"
        self.worker_evidence.mkdir(mode=0o700)

    def save(self):
        temporary = self.root / "ledger.json.tmp"
        temporary.write_text(json.dumps(self.ledger, indent=2) + "\n")
        temporary.replace(self.root / "ledger.json")

    def command(self, argv, timeout=60):
        if argv[:2] == ["docker", "run"]:
            raise ValueError("container acquisition must use the owner")
        row = {"argv": argv}
        self.ledger["commands"].append(row)
        try:
            result = subprocess.run(
                argv, cwd=self.source, capture_output=True, text=True, timeout=timeout
            )
            row["exit_code"] = result.returncode
            if result.returncode:
                raise RuntimeError(f"exit {result.returncode}: {result.stderr[:1000]}")
            return result.stdout
        except Exception as error:
            row["error"] = repr(error)
            raise

    def spawn(self, argv, env=None):
        path = self.root / f"process-{len(self.children)}.log"
        with path.open("w") as log:
            child = subprocess.Popen(
                argv, cwd=self.source, env=os.environ | (env or {}), stdout=log, stderr=log
            )
        self.children.append(child)
        child.evidence_log = path
        self.ledger["commands"].append({"argv": argv, "pid": child.pid, "log": str(path)})
        return child

    def wait_port(self, child, number):
        for _ in range(200):
            if child.poll() is not None:
                raise RuntimeError(f"child {child.pid} exited {child.returncode}")
            try:
                with socket.create_connection(("127.0.0.1", number), timeout=0.1):
                    return
            except OSError:
                time.sleep(0.05)
        raise TimeoutError("listener startup")

    @staticmethod
    def identifier(value):
        if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
            raise ValueError("malformed full container ID")
        return value

    def _resolve(self, receipt):
        cid = None
        if receipt.cidfile.exists():
            cid = self.identifier(receipt.cidfile.read_text().strip())
        output = self.command(["docker", "inspect", receipt.name], timeout=self.timeout)
        records = json.loads(output)
        if not isinstance(records, list) or len(records) != 1:
            raise ValueError("ambiguous container receipt")
        record = records[0]
        identifier = self.identifier(record["Id"])
        if record["Name"] != "/" + receipt.name:
            raise ValueError("container name mismatch")
        if record["Config"]["Labels"].get(self.label) != receipt.token:
            raise ValueError("container ownership label mismatch")
        if cid is not None and identifier != cid:
            raise ValueError("container cidfile mismatch")
        receipt.identifier = identifier
        return identifier

    def _reconcile(self, receipt):
        deadline = time.monotonic() + self.reconcile_seconds
        last_error = None
        while True:
            try:
                return self._resolve(receipt)
            except Exception as error:
                last_error = repr(error)
            if time.monotonic() >= deadline:
                receipt.errors.append("acquisition unobservable: " + last_error)
                return None
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))

    def _create(self, options, role):
        name = "crew-finance-" + uuid4().hex
        receipt = Container(name, uuid4().hex, self.root / "receipts" / f"{name}.cid", role)
        self.containers.append(receipt)
        try:
            output = self.command(
                [
                    "docker",
                    "create",
                    "--name",
                    receipt.name,
                    "--label",
                    f"{self.label}={receipt.token}",
                    "--cidfile",
                    str(receipt.cidfile),
                    *options,
                ],
                timeout=self.timeout,
            )
            identifier = self.identifier(output.strip())
            if self._resolve(receipt) != identifier:
                raise ValueError("create stdout differs from owned receipt")
        except Exception as error:
            receipt.errors.append("create: " + repr(error))
            raise
        return receipt.identifier

    def service(self, options, *, role="listener"):
        identifier = self._create(options, role)
        child = self.spawn(["docker", "start", "--attach", identifier])
        child.container_id = identifier
        return child

    def database(self, options):
        identifier = self._create(options, "database")
        self.command(["docker", "start", identifier], timeout=self.timeout)
        return identifier

    def utility(self, options, timeout=60):
        identifier = self._create(options, "utility")
        return self.command(["docker", "start", "--attach", identifier], timeout=timeout)

    def _listed(self, identifier):
        output = self.command(
            [
                "docker",
                "container",
                "ls",
                "--all",
                "--no-trunc",
                "--format",
                "{{.ID}}",
                "--filter",
                f"id={identifier}",
            ],
            timeout=self.timeout,
        )
        identifiers = [self.identifier(line) for line in output.splitlines()]
        if len(identifiers) != len(set(identifiers)) or any(i != identifier for i in identifiers):
            raise ValueError("ambiguous container listing")
        return identifier in identifiers

    def _container_cleanup(self, receipt):
        errors = receipt.errors.copy()
        identifier = receipt.identifier or self._reconcile(receipt)
        if identifier is None:
            return Outcome(receipt.role, receipt.name, "unobservable", tuple(receipt.errors))
        for operation in ("stop", "rm"):
            try:
                if not self._listed(identifier):
                    return Outcome(receipt.role, identifier, "absent", tuple(errors))
            except Exception as error:
                errors.append("observe before " + operation + ": " + repr(error))
            argv = (
                ["docker", "stop", "-t", "2", identifier]
                if operation == "stop"
                else ["docker", "rm", "--force", identifier]
            )
            try:
                self.command(argv, timeout=self.timeout)
            except Exception as error:
                errors.append(operation + ": " + repr(error))
        try:
            absence = "survivor" if self._listed(identifier) else "absent"
        except Exception as error:
            absence = "unobservable"
            errors.append("observe: " + repr(error))
        return Outcome(receipt.role, identifier, absence, tuple(errors))

    def _child_cleanup(self, child):
        errors = []
        for method in ("terminate", "kill"):
            try:
                if child.poll() is not None:
                    break
                getattr(child, method)()
            except Exception as error:
                errors.append(method + ": " + repr(error))
            try:
                child.wait(timeout=self.timeout)
            except Exception as error:
                errors.append("wait: " + repr(error))
        try:
            absence = "absent" if child.poll() is not None else "survivor"
        except Exception as error:
            absence = "unobservable"
            errors.append("poll: " + repr(error))
        return Outcome("child", str(child.pid), absence, tuple(errors))

    def telemetry(self):
        if self.worker is None:
            raise ValueError("qualification worker was not started")
        if self.worker.poll() is None:
            raise ValueError("worker is still running")
        log = self.worker.evidence_log.read_text()
        if "Exception while exporting" in log or "LocalExporter" in log:
            raise ValueError("worker exporter failed")
        path = self.worker_evidence / f"telemetry-{self.worker.pid}.jsonl"
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        if not rows or not self.expected_threads:
            raise ValueError("missing real worker telemetry expectations/output")
        matches = {
            row["attributes"].get("birbcrew.conversation_id")
            for row in rows
            if row["name"] == "conversation.persist"
            and row["attributes"].get("birbcrew.workflow_id")
            == "birbcrew-" + row["attributes"].get("birbcrew.conversation_id", "")
        }
        if not self.expected_threads <= matches:
            raise ValueError("missing real persistence span for expected thread")
        for row in rows:
            if not re.fullmatch(r"[0-9a-f]{32}", row["trace_id"]) or not re.fullmatch(
                r"[0-9a-f]{16}", row["span_id"]
            ):
                raise ValueError("malformed worker span identifiers")
        return {
            "pid": self.worker.pid,
            "path": str(path),
            "span_count": len(rows),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "expected_threads": sorted(self.expected_threads),
            "matched_threads": sorted(matches),
            "exporter_errors": False,
            "log": str(self.worker.evidence_log),
        }

    def image_evidence(self, image):
        details = json.loads(self.command(["docker", "image", "inspect", image]))[0]
        self.ledger["finance_image"] = {"id": details["Id"], "user": details["Config"]["User"]}
        hashes = json.loads(
            self.utility(
                [
                    "--rm",
                    "--network",
                    "none",
                    image,
                    "python",
                    "-I",
                    "-B",
                    "-c",
                    "import pathlib,hashlib,json,birbcrew; "
                    "p=pathlib.Path(birbcrew.__file__).parent; "
                    "print(json.dumps({str(f.relative_to(p.parent)):"
                    "hashlib.sha256(f.read_bytes()).hexdigest() "
                    "for f in p.rglob('*.py')}))",
                ]
            )
        )
        self.ledger["image_source_hashes"] = hashes
        expected = {
            str(p.relative_to(self.source / "src")): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in (self.source / "src/birbcrew").rglob("*.py")
        }
        assert hashes == expected
        for path, digest in hashes.items():
            assert hashlib.sha256((self.source / "src" / path).read_bytes()).hexdigest() == digest

    def source_hashes(self):
        paths = list((self.source / "src/birbcrew").rglob("*.py"))
        paths += list((self.source / "tests/finance").glob("*.py"))
        paths += list((self.source / "tests/execution").glob("test_journal*.py"))
        return {
            str(p.relative_to(self.source)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in paths
        }

    def finish(self):
        if self.completion is not None:
            return self.completion
        outcomes = []
        for receipt in [r for r in self.containers if r.role != "database"]:
            outcomes.append(self._container_cleanup(receipt))
        for child in reversed(self.children):
            outcomes.append(self._child_cleanup(child))
        for receipt in [r for r in self.containers if r.role == "database"]:
            outcomes.append(self._container_cleanup(receipt))
        self.ledger["cleanup"] = [asdict(outcome) for outcome in outcomes]
        self.ledger["container_receipts"] = [
            {**asdict(receipt), "cidfile": str(receipt.cidfile)} for receipt in self.containers
        ]
        evidence_errors = {}
        for name, collect in [
            ("worker_telemetry", self.telemetry),
            ("source_hashes", self.source_hashes),
        ]:
            try:
                self.ledger[name] = collect()
            except Exception as error:
                evidence_errors[name] = repr(error)
        self.ledger["evidence_errors"] = evidence_errors
        failed = (
            bool(self.ledger.get("fatal"))
            or any(c["status"] == "fail" for c in self.ledger["cases"])
            or any(not outcome.ok for outcome in outcomes)
            or bool(evidence_errors)
        )
        self.ledger["exit_code"] = int(failed)
        ledger_error = None
        try:
            self.save()
        except Exception as error:
            ledger_error = repr(error)
            self.ledger["ledger_write_error"] = ledger_error
            self.ledger["exit_code"] = 1
            print(json.dumps(self.ledger, indent=2), file=sys.stderr)
        self.completion = Completion(tuple(outcomes), ledger_error, self.ledger["exit_code"])
        return self.completion
