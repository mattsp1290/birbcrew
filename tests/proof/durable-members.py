"""Run the member CLI against disposable PostgreSQL, Temporal, and real SDK processes."""

import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager
from uuid import uuid4

from approval_cases import verify_approvals


ROOT = Path(__file__).resolve().parents[2]
POSTGRES = "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"


def run(*command, **options):
    return subprocess.run(command, check=True, text=True, cwd=ROOT, **options)


def wait_until(check, name):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.2)
    raise TimeoutError(name)


@contextmanager
def child(command, env, log_path):
    with log_path.open("ab") as log:
        proc = subprocess.Popen(command, cwd=ROOT, env=env, stdout=log, stderr=log, start_new_session=True)
        try:
            yield proc
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=10)


def verify(directory, stack):
    node = shutil.which("node")
    temporal = os.environ.get("TEMPORAL_CLI") or shutil.which("temporal") or str(ROOT / ".proof/bin/temporal")
    if not node or subprocess.check_output([node, "--version"], text=True).strip() != "v22.23.3":
        raise RuntimeError("Activate Node 22.23.3 before running verify-members")
    run(temporal, "--version")
    secret = secrets.token_hex(24)
    db = run("docker", "run", "--rm", "-d", "-e", f"POSTGRES_PASSWORD={secret}",
             "-e", "POSTGRES_DB=birbcrew_ts", "-p", "127.0.0.1::5432", POSTGRES, capture_output=True).stdout.strip()
    stack.callback(run, "docker", "rm", "-f", db, stdout=subprocess.DEVNULL)
    def database_url():
        port = run("docker", "port", db, "5432/tcp", capture_output=True).stdout.strip().rsplit(":", 1)[1]
        return f"postgres://postgres:{secret}@127.0.0.1:{port}/birbcrew_ts"
    db_ready = lambda: subprocess.call(["docker", "exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0
    wait_until(db_ready, "PostgreSQL startup")
    with socket.socket() as port_picker:
        port_picker.bind(("127.0.0.1", 0))
        address = f"127.0.0.1:{port_picker.getsockname()[1]}"
    url = database_url()
    env = {
        "PATH": os.environ["PATH"], "HOME": str(directory), "BIRBCREW_DATABASE_URL": url,
        "BIRBCREW_TEST_DATABASE_URL": url, "BIRBCREW_TEMPORAL_ADDRESS": address,
        "BIRBCREW_STATE_DIR": str(directory / "native"),
        "BIRBCREW_PROOF_REQUESTS": str(directory / "requests.jsonl"),
    }
    cli = [node, "src/service/cli.ts"]
    run(node, "--test", "tests/service/store.test.ts", "tests/service/providers.test.ts",
        "tests/service/approvals.test.ts", "tests/fixtures/engines/pi/protected.test.ts",
        "tests/fixtures/engines/claude/protected.test.ts",
        "tests/fixtures/engines/pi/durable.test.ts", "tests/fixtures/engines/claude/durable.test.ts", env=env)

    def command(op, payload, fail=False):
        result = subprocess.run([*cli, op], input=json.dumps(payload), capture_output=True, text=True,
                                cwd=ROOT, env=env, timeout=200)
        if fail:
            assert result.returncode != 0, f"{op} accepted invalid request"
            return
        if result.returncode:
            raise RuntimeError(f"{op} failed for {payload.get('ownerId')}: {result.stderr.strip()}")
        return json.loads(result.stdout)

    def worker(runtime, engine=None):
        worker_env = env if engine is None else {**env, "BIRBCREW_PROOF_ENGINE": engine}
        return runtime.enter_context(child([*cli, "worker", "tests/proof/fixture-profiles.mts"],
                                           worker_env, directory / "worker.log"))

    def services(runtime, split=False):
        temporal_proc = runtime.enter_context(child([temporal, "server", "start-dev", "--headless",
            "--port", address.rsplit(":", 1)[1], "--db-filename", str(directory / "temporal.db")],
            env, directory / "temporal.log"))
        def healthy():
            if temporal_proc.poll() is not None:
                raise RuntimeError("Temporal exited")
            return subprocess.call([temporal, "operator", "cluster", "health", "--address", address,
                                    "--command-timeout", "1s"], env=env, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL) == 0
        wait_until(healthy, "Temporal health")
        if split:
            worker(runtime, "pi")
            return worker(runtime, "claude")
        return worker(runtime)

    def turn(conv, text, request_id=None):
        return {"ownerId": conv["ownerId"], "conversationId": conv["conversationId"],
                "requestId": request_id or str(uuid4()), "text": text}

    cases = []
    with ExitStack() as runtime:
        services(runtime, split=True)
        def ready_profiles():
            result = subprocess.run(["docker", "exec", db, "psql", "-U", "postgres", "-d", "birbcrew_ts",
                                     "-Atc", "SELECT count(*) FROM birbcrew_ts.profiles WHERE name='fixture.v1'"],
                                    text=True, capture_output=True)
            return result.returncode == 0 and result.stdout.strip() == "2"
        wait_until(ready_profiles, "worker profiles registered")
        run(node, "--test", "tests/service/closure.test.ts", env=env)
        for engine in ["pi", "claude"]:
            owner = f"{engine}-{uuid4()}"
            spawn = {"ownerId": owner, "requestId": str(uuid4()), "engine": engine, "profile": "fixture.v1"}
            member = command("spawn", spawn)
            assert command("spawn", spawn) == member
            for _ in range(2):
                conv = command("open", {"ownerId": owner, "memberId": member["memberId"], "conversationId": str(uuid4())})
                nonce = str(uuid4())
                cases.append((conv, nonce, turn(conv, "remember " + nonce)))
        def initial(case):
            _, nonce, request = case
            assert command("turn", request) == {"text": "stored " + nonce}
        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(initial, cases))
    print("Replaced the worker and Temporal server after four committed turns.", flush=True)
    run("docker", "restart", db, stdout=subprocess.DEVNULL)
    wait_until(db_ready, "PostgreSQL restart")
    env["BIRBCREW_DATABASE_URL"] = env["BIRBCREW_TEST_DATABASE_URL"] = database_url()
    with ExitStack() as runtime:
        current = services(runtime)
        def resume(case):
            conv, nonce, original = case
            assert command("turn", original) == {"text": "stored " + nonce}
            command("turn", {**original, "text": "changed"}, fail=True)
            command("turn", {**turn(conv, "recall"), "ownerId": "other-owner"}, fail=True)
            command("turn", {**turn(conv, "recall"), "engine": conv["engine"]}, fail=True)
            assert command("turn", turn(conv, "recall")) == {"text": "recalled " + nonce}
        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(resume, cases))
        def sql(statement):
            return run("docker", "exec", db, "psql", "-U", "postgres", "-d", "birbcrew_ts", "-Atc", statement,
                       capture_output=True).stdout.strip()
        current = verify_approvals(runtime, current, worker, command, wait_until, sql)
        for override in [{"BIRBCREW_STATE_DIR": str(directory / "wrong-volume")},
                         {"BIRBCREW_PROOF_ACCOUNT": "another-account"}]:
            invalid = subprocess.run([*cli, "worker", "tests/proof/fixture-profiles.mts"],
                                     cwd=ROOT, env={**env, **override}, capture_output=True, text=True, timeout=20)
            assert invalid.returncode and "another account or native state volume" in invalid.stderr
        print("Claude and Pi each recalled both independent conversations after cold restart.", flush=True)
        def requests():
            return [json.loads(line) for line in (directory / "requests.jsonl").read_text().splitlines()]
        for conv, nonce, _ in cases:
            assert requests().count({"engine": conv["engine"], "prompt": "remember " + nonce}) == 1
        with ThreadPoolExecutor(max_workers=2) as executor:
            pending = [executor.submit(command, "turn", turn(conv, "wait"), True)
                       for conv, _, _ in (cases[0], cases[2])]
            wait_until(lambda: {r["engine"] for r in requests() if r["prompt"] == "wait"} == {"claude", "pi"},
                       "both providers started the interrupted turn")
            current.kill()
            current.wait(timeout=10)
            worker(runtime)
            for future in pending:
                future.result(timeout=90)
        assert [r["prompt"] for r in requests()].count("wait") == 2
        uncertain = run("docker", "exec", db, "psql", "-U", "postgres", "-d", "birbcrew_ts", "-Atc",
                        "SELECT conversation_id FROM birbcrew_ts.turns WHERE phase='uncertain'", capture_output=True)
        interrupted = {cases[0][0]["conversationId"], cases[2][0]["conversationId"]}
        assert interrupted.issubset(uncertain.stdout.splitlines())
        print("Both interrupted native calls stayed uncertain after worker replacement; neither was resubmitted.")
        run(node, "--test", "tests/service/observation.test.ts", env=env)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="birb-members-") as tmp, ExitStack() as stack:
        directory = Path(tmp)
        try:
            verify(directory, stack)
        except BaseException:
            for name in ["temporal.log", "worker.log"]:
                path = directory / name
                if path.exists():
                    print(path.read_text()[-6000:])
            raise
