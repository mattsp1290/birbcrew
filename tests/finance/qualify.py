import argparse
import asyncio
import concurrent.futures
import hashlib
import http.client
import importlib.metadata
import json
import os
import socket
import ssl
import sys
import time
import traceback
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from resources import QualificationRun

from birbcrew import store
from birbcrew.config import settings
from birbcrew.domain import Conversation
from birbcrew.finance import thread_store

parser = argparse.ArgumentParser()
parser.add_argument("--evidence-dir", type=Path, required=True)
parser.add_argument("--temporal-cli", type=Path, required=True)
parser.add_argument("--image", required=True)
args = parser.parse_args()
ROOT = args.evidence_dir.resolve()
ROOT.mkdir(mode=0o700, parents=True, exist_ok=False)
os.umask(0o077)
RUN = ROOT
SOURCE = Path(__file__).resolve().parents[2]
URI = "spiffe://synthetic.invalid/service/go-finance"
IMAGE = "postgres@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f"
BOOT = [
    sys.executable,
    "-I",
    "-B",
    "-c",
    "import sys,runpy;sys.path.insert(0,sys.argv.pop(1));"
    "runpy.run_module(sys.argv.pop(1),run_name='__main__')",
    str(SOURCE / "src"),
]
run = QualificationRun(ROOT, SOURCE)
ledger = run.ledger
command = run.command
spawn = run.spawn
save = run.save
wait_port = run.wait_port


def connect():
    return psycopg.connect(DSN, row_factory=dict_row)


def counts():
    with connect() as db:
        return {
            t: db.execute("SELECT count(*) AS n FROM " + t).fetchone()["n"]
            for t in ["conversations", "finance_threads", "events", "operations"]
        }


def events():
    return [
        json.loads(line)
        for p in (ROOT / "events").glob("events-*.jsonl")
        for line in p.read_text().splitlines()
    ]


def case(name, fn):
    try:
        result = fn()
        entry = {"name": name, "status": "pass", "observed": result}
    except Exception as error:
        entry = {
            "name": name,
            "status": "fail",
            "error": repr(error),
            "trace": traceback.format_exc(),
        }
    ledger["cases"].append(entry)
    save()
    print(name, entry["status"], flush=True)
    return entry.get("observed")


def config(number, max_age=30):
    path = ROOT / f"listener-{number}.json"
    path.write_text(
        json.dumps(
            dict(
                host="127.0.0.1",
                port=number,
                certificate="/proof/server.crt",
                private_key="/proof/server.key",
                client_ca="/proof/ca.crt",
                runtime_config="/proof/container-runtime.json",
                service_uri=URI,
                max_connection_age=float(max_age),
            )
        )
    )
    return path


def start_server(max_age=30, crash=None, actual=False, mutant=None):
    number = port()
    cfg = config(number, max_age)
    argv = [
        "--rm",
        "--init",
        "--network",
        "host",
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        "--memory=512m",
        "--cpus=1",
        "--pids-limit=128",
        "--mount",
        f"type=bind,src={ROOT},dst=/proof,readonly",
        "--mount",
        f"type=bind,src={ROOT / 'events'},dst=/events",
        "--mount",
        f"type=bind,src={SOURCE / 'tests/finance'},dst=/tests,readonly",
        "--env",
        f"BIRBCREW_FINANCE_CONFIG=/proof/{cfg.name}",
        "--env",
        "FINANCE_PROOF_DIR=/events",
    ]
    if crash:
        argv += ["--env", "FINANCE_PROOF_CRASH=" + crash]
    if mutant:
        argv += ["--env", "FINANCE_PROOF_TIMER=" + mutant]
    argv += [args.image]
    if not actual:
        argv += ["python", "-I", "-B", "/tests/listener.py"]
    child = run.service(argv)
    wait_port(child, number)
    child.listener_name = child.container_id
    return child, number


def request(
    number, owner=None, cid=None, identity="go", body=b"{}", path=None, plain=False, headers=None
):
    if path is None:
        path = f"/internal/v1/finance/owners/{owner}/" + (
            f"threads/{cid}/snapshot" if cid else "thread"
        )
    method = "GET" if cid or (path and path.endswith("/sse")) else "POST"
    cls = http.client.HTTPConnection if plain else http.client.HTTPSConnection
    client = cls(
        "127.0.0.1", number, timeout=15, **({} if plain else {"context": context(identity)})
    )
    try:
        client.request(method, path, body, {"Content-Type": "application/json", **(headers or {})})
        response = client.getresponse()
        data = response.read()
        return response.status, json.loads(data) if data else None
    finally:
        client.close()


def port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def cert(name, uri=None, issuer="ca", seconds=3600, ambiguous=False):
    command(
        [
            "openssl",
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(RUN / f"{name}.key"),
            "-out",
            str(RUN / f"{name}.csr"),
            "-subj",
            f"/CN={name}",
        ]
    )
    ext = RUN / f"{name}.ext"
    san = "DNS:localhost,IP:127.0.0.1" if name == "server" else "URI:" + uri
    if ambiguous:
        san += ",URI:spiffe://synthetic.invalid/service/other"
    ext.write_text(
        "[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage="
        + ("serverAuth" if name == "server" else "clientAuth")
        + "\nsubjectAltName="
        + san
        + "\n"
    )
    now = datetime.now(UTC)

    def fmt(d):
        return d.strftime("%Y%m%d%H%M%SZ")

    command(
        [
            "openssl",
            "ca",
            "-batch",
            "-notext",
            "-config",
            str(RUN / f"{issuer}.cnf"),
            "-extensions",
            "leaf",
            "-extfile",
            str(ext),
            "-startdate",
            fmt(now - timedelta(seconds=10)),
            "-enddate",
            fmt(now + timedelta(seconds=seconds)),
            "-in",
            str(RUN / f"{name}.csr"),
            "-out",
            str(RUN / f"{name}.crt"),
        ]
    )


def context(identity="go"):
    c = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    c.minimum_version = c.maximum_version = ssl.TLSVersion.TLSv1_3
    c.load_verify_locations(RUN / "ca.crt")
    if identity:
        c.load_cert_chain(RUN / f"{identity}.crt", RUN / f"{identity}.key")
    return c


def main():
    global DSN
    ledger["versions"] = {
        "python": sys.version,
        **{name: importlib.metadata.version(name) for name in ["uvicorn", "psycopg", "temporalio"]},
    }
    assert sys.version_info[:3] == (3, 13, 12)
    assert ledger["versions"]["uvicorn"] == "0.54.0"
    run.image_evidence(args.image)
    ledger["postgres_image"] = json.loads(command(["docker", "image", "inspect", IMAGE]))[0]["Id"]
    password = os.urandom(24).hex()
    (ROOT / "postgres.env").write_text(
        "POSTGRES_PASSWORD=" + password + "\nPOSTGRES_DB=synthetic\n"
    )
    container = run.database(
        [
            "--pull=never",
            "--memory=256m",
            "--cpus=1",
            "--pids-limit=128",
            "--tmpfs",
            "/var/lib/postgresql/data:rw,size=192m",
            "--publish",
            "127.0.0.1::5432",
            "--env-file",
            str(ROOT / "postgres.env"),
            IMAGE,
        ]
    )
    pgport = int(command(["docker", "port", container, "5432/tcp"]).strip().rsplit(":", 1)[1])
    DSN = f"host=127.0.0.1 port={pgport} dbname=synthetic user=postgres password={password}"
    temporal_port = port()
    temporal = spawn(
        [
            str(args.temporal_cli),
            "server",
            "start-dev",
            "--ip",
            "127.0.0.1",
            "--port",
            str(temporal_port),
            "--headless",
            "--db-filename",
            str(ROOT / "temporal.db"),
        ]
    )
    wait_port(temporal, temporal_port)
    runtime = dict(
        database_url=DSN,
        temporal_address=f"127.0.0.1:{temporal_port}",
        task_queue="finance-" + uuid4().hex,
        token_hashes={},
        context=dict(project="synthetic", actor="synthetic", commit="0" * 40, notes=[]),
        evidence_dir=str(ROOT / "worker-evidence"),
        mode="test",
    )
    (ROOT / "runtime.json").write_text(json.dumps(runtime))
    (ROOT / "container-runtime.json").write_text(json.dumps(runtime))
    (ROOT / "events").mkdir()
    os.environ["BIRBCREW_CONFIG"] = str(ROOT / "runtime.json")
    settings.cache_clear()
    for _ in range(100):
        try:
            with connect() as db:
                ledger["versions"]["postgres"] = db.execute(
                    "SELECT version() AS version"
                ).fetchone()["version"]
            break
        except psycopg.OperationalError:
            time.sleep(0.1)

    def migration():
        migrations = [spawn(BOOT + ["birbcrew.migrate"]) for _ in range(4)]
        assert all(p.wait(timeout=30) == 0 for p in migrations)
        asyncio.run(thread_store.ready())
        return {"concurrent_migrators": 4, "ready": True}

    case("concurrent_migration_and_readiness", migration)
    for ca in ["ca", "untrusted-ca"]:
        command(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-keyout",
                str(ROOT / f"{ca}.key"),
                "-out",
                str(ROOT / f"{ca}.crt"),
                "-subj",
                f"/CN={ca}",
                "-days",
                "1",
            ]
        )
        (ROOT / f"{ca}.index").write_text("")
        (ROOT / f"{ca}.serial").write_text("1000\n")
        (ROOT / f"{ca}.cnf").write_text(
            f"[ca]\ndefault_ca=main\n[main]\ndatabase={ROOT}/{ca}.index\nserial={ROOT}/{ca}.serial\nnew_certs_dir={ROOT}\ncertificate={ROOT}/{ca}.crt\nprivate_key={ROOT}/{ca}.key\ndefault_md=sha256\npolicy=names\nunique_subject=no\n[names]\ncommonName=supplied\n"
        )
    cert("server")
    cert("go", URI)
    cert("wrong", "spiffe://synthetic.invalid/wrong")
    cert("ambiguous", URI, ambiguous=True)
    cert("untrusted", URI, issuer="untrusted-ca")
    mounts = {
        name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
        for name in ["ca.crt", "server.crt", "server.key", "go.crt", "go.key"]
    }
    ledger["mounted_identity_hashes"] = mounts
    worker = run.worker = spawn(BOOT + ["birbcrew.worker"])
    for _ in range(100):
        if worker.poll() is not None:
            raise RuntimeError("worker exited")
        if "worker-ready" in worker.evidence_log.read_text():
            break
        time.sleep(0.1)
    else:
        raise TimeoutError("worker ready")
    p, n = start_server()
    p2, n2 = start_server()
    owner = str(uuid4())

    def deny(identity):
        before = counts()
        entries = len([e for e in events() if e["kind"] == "app_entry"])
        outcomes = []
        for cid in [None, str(uuid4())]:
            try:
                outcomes.append(
                    request(
                        n,
                        owner,
                        cid,
                        identity=identity,
                        headers={"Authorization": "Bearer forged", "X-Service-Identity": URI},
                    )[0]
                )
            except (OSError, http.client.HTTPException) as error:
                outcomes.append(type(error).__name__)
        assert all(not isinstance(x, int) for x in outcomes)
        assert (
            counts() == before and len([e for e in events() if e["kind"] == "app_entry"]) == entries
        )
        return {"outcomes": outcomes, "zero_dispatch": True}

    for identity in [None, "untrusted", "wrong", "ambiguous"]:
        case("denial_" + str(identity), lambda identity=identity: deny(identity))

    def valid():
        status, state = request(n, owner)
        assert status == 200, (status, state)
        for _ in range(100):
            status, snapshot = request(n, owner, state["id"])
            if snapshot["revision"] > 0:
                break
            time.sleep(0.05)
        assert status == 200 and snapshot["revision"] == 1 and snapshot["cursor"] == 2
        assert snapshot["owner"] == owner
        return {
            "id": state["id"],
            "revision": snapshot["revision"],
            "finalized_cursor": snapshot["cursor"],
        }

    first = case("actual_temporal_initialize_snapshot", valid)
    if not first:
        raise RuntimeError("valid control failed")
    cid = first["id"]
    run.expected_threads.add(cid)

    def race():
        who = str(uuid4())
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            replies = list(pool.map(lambda i: request([n, n2][i % 2], who), range(32)))
        assert all(s == 200 for s, d in replies), replies
        ids = {d["id"] for s, d in replies}
        assert len(ids) == 1
        with connect() as db:
            assert (
                db.execute(
                    "SELECT count(*) AS n FROM conversations WHERE owner=%s", (who,)
                ).fetchone()["n"]
                == 1
            )
        return {"requests": 32, "pids": [p.pid, p2.pid], "winner": ids.pop()}

    case("independent_listener_allocation_race", race)

    def peers():
        before = len([e for e in events() if e["kind"] == "app_entry"])
        who = str(uuid4())

        def call(i):
            try:
                return request([n, n2][i % 2], who, identity="go" if i % 3 == 0 else "wrong")[0]
            except (OSError, http.client.HTTPException):
                return "denied"

        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            replies = list(pool.map(call, range(24)))
        assert replies.count(200) == 8 and replies.count("denied") == 16
        assert len([e for e in events() if e["kind"] == "app_entry"]) - before == 8
        return {"allowed": 8, "denied": 16}

    case("concurrent_peer_separation", peers)

    def owner_boundary():
        other = str(uuid4())
        assert request(n, other, cid)[0] == 404
        assert request(n, other, str(uuid4()))[0] == 404
        assert request(n, other)[1]["id"] != cid
        for invalid in [owner.upper(), "ownerA", str(UUID(int=1))]:
            assert request(n, invalid)[0] == 422
        assert request(n, str(uuid4()), body=json.dumps({"id": cid}).encode())[0] == 422
        return {"foreign_and_absent": 404, "invalid_owner_and_body": 422}

    case("canonical_owner_and_empty_body", owner_boundary)

    def collisions():
        original = thread_store.uuid4
        ordinary = str(uuid4())
        asyncio.run(
            store.create(Conversation(id=ordinary, owner="opaque", context=settings().context))
        )
        for collision in [ordinary, cid]:
            sequence = iter([UUID(collision), uuid4()])
            thread_store.uuid4 = lambda: next(sequence)
            try:
                thread = asyncio.run(
                    thread_store.initialize(thread_store.FinanceOwner(str(uuid4())))
                )
                assert str(thread.conversation_id) != collision
            finally:
                thread_store.uuid4 = original
        with connect() as db:
            orphans = db.execute(
                "SELECT count(*) AS n FROM finance_threads f LEFT JOIN conversations c "
                "ON f.conversation_id=c.id AND f.owner=c.owner WHERE c.id IS NULL"
            ).fetchone()["n"]
        assert orphans == 0
        return {"collisions_retried": 2, "orphans": orphans}

    case("actual_collision_rollback_retry", collisions)

    def crash_recovery(where):
        who = str(uuid4())
        child, number = start_server(crash=where)
        try:
            request(number, who)
        except (OSError, http.client.HTTPException):
            pass
        assert child.wait(timeout=10) == (71 if where == "before" else 72)
        with connect() as db:
            stored = db.execute(
                "SELECT conversation_id FROM finance_threads WHERE owner=%s", (who,)
            ).fetchone()["conversation_id"]
        replacement, number = start_server(actual=True)
        status, state = request(number, who)
        assert status == 200 and state["id"] == stored
        assert request(number, who)[1]["id"] == stored
        assert all(
            hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == value
            for name, value in mounts.items()
        )
        return {
            "same_id": stored,
            "crash_exit": child.returncode,
            "replacement_pid": replacement.pid,
            "mounts_unchanged": True,
        }

    case("commit_before_start_crash_recovery", lambda: crash_recovery("before"))
    case("accepted_start_lost_acknowledgement", lambda: crash_recovery("after"))

    def advanced():
        who = str(uuid4())
        thread = asyncio.run(thread_store.initialize(thread_store.FinanceOwner(who)))
        with connect() as db:
            db.execute(
                "UPDATE conversations SET revision=1,snapshot=jsonb_set(snapshot,'{revision}','1') "
                "WHERE id=%s",
                (str(thread.conversation_id),),
            )
        status, state = request(n, who)
        assert status == 503 and state["detail"] == "finance_workflow_recovery_required"
        return {"status": status, "same_binding": str(thread.conversation_id)}

    case("advanced_state_missing_workflow_refusal", advanced)

    def keepalive():
        client = http.client.HTTPSConnection("127.0.0.1", n, context=context(), timeout=10)
        path = f"/internal/v1/finance/owners/{owner}/thread"
        client.request("POST", path, b"{}", {"Content-Type": "application/json"})
        response = client.getresponse()
        a = json.loads(response.read())
        sock = client.sock
        client.request("POST", path, b"{}", {"Content-Type": "application/json"})
        response = client.getresponse()
        b = json.loads(response.read())
        assert response.status == 200 and a["id"] == b["id"] and sock is client.sock
        client.close()
        return {"same_socket": True, "same_thread": True}

    case("keepalive", keepalive)
    from deadline_check import observe_deadline

    case(
        "suspended_stream_max_age", lambda: observe_deadline("go", 1.2, start_server, context, ROOT)
    )
    cert("short", URI, seconds=5)
    case(
        "suspended_stream_certificate_expiry",
        lambda: observe_deadline("short", 30, start_server, context, ROOT),
    )
    case("expired_certificate", lambda: deny("short"))

    def reuse():
        ctx = context()
        with socket.create_connection(("127.0.0.1", n)) as raw:
            with ctx.wrap_socket(raw, server_hostname="localhost") as tls:
                tls.sendall(
                    b"GET /missing HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
                )
                while tls.recv(4096):
                    pass
                session = tls.session
        with socket.create_connection(("127.0.0.1", n)) as raw:
            with ctx.wrap_socket(raw, server_hostname="localhost", session=session) as tls:
                reused = tls.session_reused
        assert not reused
        return {"session_reused": reused, "ticket": session.has_ticket, "established": False}

    case("session_reuse_attempt", reuse)

    def public():
        import httpx

        from birbcrew import api
        from birbcrew.domain import ProjectContext

        old = settings().token_hashes.copy()
        settings().token_hashes.update(
            {
                owner: hashlib.sha256(b"same").hexdigest(),
                "foreign": hashlib.sha256(b"other").hexdigest(),
            }
        )
        settings().project_service_token_sha256 = hashlib.sha256(b"project").hexdigest()
        context_value = ProjectContext.model_validate(
            {
                "schema_version": "birbcrew.project-context.v1",
                "project_id": "synthetic",
                "project_revision": "a" * 40,
                "project_name": "Synthetic",
                "repositories": [
                    {
                        "repository_id": "1",
                        "full_name": "owner/repo",
                        "url": "https://github.com/owner/repo",
                        "commit": "b" * 40,
                    }
                ],
                "sources": [],
                "notes": settings().context.model_dump(mode="json"),
            }
        )
        prompt = {"request_id": str(uuid4()), "text": "synthetic"}
        project_prompt = {**prompt, "context_sha256": context_value.digest}
        paths = [
            ("/conversations", {"id": cid}),
            (f"/conversations/{cid}/inputs", prompt),
            (
                f"/conversations/{cid}/human",
                {"request_id": "synthetic", "version": 1, "choice": "test"},
            ),
            (f"/conversations/{cid}/cancel", {}),
            (
                f"/conversations/{cid}/events",
                {
                    "threadId": cid,
                    "runId": str(uuid4()),
                    "state": {},
                    "messages": [],
                    "tools": [],
                    "context": [],
                    "forwardedProps": {},
                },
            ),
            (
                "/internal/project-conversations",
                {"id": cid, "context": context_value.model_dump(mode="json")},
            ),
            (f"/internal/project-conversations/{cid}/inputs", project_prompt),
            (f"/internal/project-conversations/{cid}/reconcile", project_prompt),
        ]

        async def exercise():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=api.app), base_url="http://test"
            ) as client:
                for token in ["same", "other"]:
                    headers = {
                        "Authorization": "Bearer " + token,
                        "X-Birbforge-Project-Token": "project",
                    }
                    assert (
                        await client.get("/conversations/" + cid, headers=headers)
                    ).status_code == 404
                    for path, body in paths:
                        reply = await client.post(path, json=body, headers=headers)
                        assert reply.status_code == 404, (path, reply.status_code, reply.text)
                    for path in ["/conversations", "/conversations?project_id=synthetic"]:
                        reply = await client.get(path, headers=headers)
                        assert reply.status_code == 200
                        assert cid not in {r["id"] for r in reply.json()}
            for _ in range(2):
                await store.create(
                    Conversation(id=str(uuid4()), owner=owner, context=settings().context)
                )
            assert len(await store.conversations_for_owner(owner)) == 2
            project = Conversation(
                id=str(uuid4()),
                owner=owner,
                context=settings().context,
                kind="project",
                project_context=context_value,
            )
            await store.create(project)
            async with await store.connect() as db:
                await db.execute(
                    "UPDATE conversations SET snapshot=snapshot || %s WHERE id=%s",
                    (
                        Jsonb(
                            {
                                "kind": "project",
                                "project_context": context_value.model_dump(mode="json"),
                            }
                        ),
                        cid,
                    ),
                )
            assert [r["id"] for r in await store.conversations_for_owner(owner, "synthetic")] == [
                project.id
            ]

        try:
            asyncio.run(exercise())
        finally:
            settings().token_hashes.clear()
            settings().token_hashes.update(old)
            settings().project_service_token_sha256 = None
        return {
            "denied_requests": 18,
            "status": 404,
            "both_lists_hide_finance": True,
            "ordinary_multiplicity": 2,
            "project_positive_and_shaped_finance": True,
            "transport": "actual ASGI app",
        }

    case("public_bearer_isolation", public)

    def provenance():
        import httpx

        from birbcrew.finance.api import create_app

        async def check():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=create_app(None)), base_url="http://test"
            ) as client:
                reply = await client.post(
                    f"/internal/v1/finance/owners/{owner}/thread",
                    json={},
                    headers={"Authorization": "Bearer forged", "X-Service-Identity": URI},
                )
                assert reply.status_code == 403

        asyncio.run(check())
        return {"status": 403, "transport": "plain ASGI"}

    case("unadapted_private_app_rejects", provenance)

    def config_failures():
        rejected = []
        for name in [
            "relative",
            "unknown",
            "missing",
            "mismatch",
            "weak",
            "symlink",
            "malformed",
            "parent",
            "schema",
        ]:
            number = port()
            cfg = config(number)
            value = json.loads(cfg.read_text())
            if name == "relative":
                value["private_key"] = "relative"
            elif name == "unknown":
                value["proxy_headers"] = True
            elif name == "missing":
                value["private_key"] = "/proof/missing"
            elif name == "mismatch":
                value["private_key"] = "/proof/go.key"
            cfg.write_text(json.dumps(value))
            if name == "weak":
                cfg.chmod(0o644)
            elif name == "symlink":
                link = ROOT / "linked.json"
                link.symlink_to(cfg.name)
                cfg = link
            elif name == "malformed":
                cfg.write_text("{")
            elif name == "parent":
                parent = ROOT / "weak-parent"
                parent.mkdir(mode=0o777)
                parent.chmod(0o777)
                target = parent / cfg.name
                target.write_bytes(cfg.read_bytes())
                cfg = target
            elif name == "schema":
                with connect() as db:
                    db.execute("ALTER TABLE finance_threads RENAME TO unavailable_finance_threads")
            child = run.service(
                [
                    "--rm",
                    "--network",
                    "host",
                    "--user",
                    f"{os.getuid()}:{os.getgid()}",
                    "--mount",
                    f"type=bind,src={ROOT},dst=/proof,readonly",
                    "--env",
                    "BIRBCREW_FINANCE_CONFIG=/proof/" + str(cfg.relative_to(ROOT)),
                    args.image,
                ]
            )
            opened = False
            try:
                for _ in range(200):
                    if child.poll() is not None:
                        break
                    try:
                        with socket.create_connection(("127.0.0.1", number), timeout=0.02):
                            opened = True
                    except OSError:
                        pass
                    time.sleep(0.03)
                assert child.wait(timeout=2) != 0 and not opened, name
                rejected.append(name)
            finally:
                if name == "schema":
                    with connect() as db:
                        db.execute(
                            "ALTER TABLE unavailable_finance_threads RENAME TO finance_threads"
                        )
        return {"rejected_before_binding": rejected}

    case("protected_file_and_schema_boundaries", config_failures)
    from deadline_check import DeadlineAssertion

    def deadline_control(mutant, expiry):
        if expiry:
            cert("short", URI, seconds=5)

        def start(max_age):
            return start_server(max_age=max_age, mutant=mutant)

        try:
            observed = observe_deadline(
                "short" if expiry else "go", 30 if expiry else 1.2, start, context, ROOT
            )
        except DeadlineAssertion as error:
            return {"expected_assertion_failure": True, "observed": error.observed}
        raise AssertionError(observed)

    for mutant in ["delayed", "early", "unrelated"]:
        for expiry in [False, True]:
            case(
                f"deadline_discrimination_{mutant}_{'expiry' if expiry else 'age'}",
                lambda mutant=mutant, expiry=expiry: deadline_control(mutant, expiry),
            )

    def retained_duplicate_start():
        from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
        from temporalio.exceptions import WorkflowAlreadyStartedError

        from birbcrew.config import temporal_client
        from birbcrew.domain import workflow_id
        from birbcrew.finance.api import ensure_workflow

        who = str(uuid4())
        status, state = request(n, who)
        assert status == 200

        async def exercise():
            client = await temporal_client(plugins=[PydanticAIPlugin()])
            handle = client.get_workflow_handle(workflow_id(state["id"]))
            before = await handle.describe()
            duplicates = []

            class ObservedClient:
                async def start_workflow(self, *args, **kwargs):
                    try:
                        return await client.start_workflow(*args, **kwargs)
                    except WorkflowAlreadyStartedError:
                        duplicates.append(True)
                        raise

            initial = {**state, "revision": 0}
            await ensure_workflow(initial, ObservedClient())
            after = await handle.describe()
            assert duplicates == [True] and before.run_id == after.run_id
            return {
                "actual_already_started": True,
                "same_run_id": after.run_id,
                "workflow_id": workflow_id(state["id"]),
            }

        return asyncio.run(exercise())

    case("retained_temporal_already_started", retained_duplicate_start)

    def unavailable_temporal():
        who = str(uuid4())
        temporal.terminate()
        temporal.wait(timeout=5)
        status, reply = request(n, who)
        assert status == 503 and reply["detail"] == "finance_start_pending_retry_initialize"
        with connect() as db:
            stored = db.execute(
                "SELECT conversation_id FROM finance_threads WHERE owner=%s", (who,)
            ).fetchone()["conversation_id"]
        replacement = spawn(temporal.args)
        wait_port(replacement, temporal_port)
        for _ in range(3):
            status, reply = request(n, who)
            if status == 200:
                break
        assert status == 200 and reply["id"] == stored
        return {
            "unavailable_status": 503,
            "retry_status": 200,
            "same_thread": stored,
            "temporal_restarted_with_same_database": True,
        }

    case("real_temporal_unavailable_retry", unavailable_temporal)

    def default_image_replacement():
        import shutil

        directory = ROOT / "uid10001-mount"
        directory.mkdir()
        for name in ["ca.crt", "server.crt", "server.key", "container-runtime.json"]:
            shutil.copyfile(ROOT / name, directory / name)
            (directory / name).chmod(0o600)
        number = port()
        value = json.loads(config(number).read_text())
        (directory / "listener.json").write_text(json.dumps(value))
        hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.iterdir()}
        run.utility(
            [
                "--rm",
                "--network",
                "none",
                "--user",
                "0:0",
                "--mount",
                f"type=bind,src={directory},dst=/owned",
                args.image,
                "python",
                "-I",
                "-B",
                "-c",
                "import os,pathlib; p=pathlib.Path('/owned'); "
                "[os.chown(f,10001,10001) for f in [p,*p.iterdir()]]",
            ]
        )
        who = str(uuid4())
        states = []
        identities = []
        for _ in range(2):
            child = run.service(
                [
                    "--rm",
                    "--init",
                    "--network",
                    "host",
                    "--memory=512m",
                    "--cpus=1",
                    "--pids-limit=128",
                    "--mount",
                    f"type=bind,src={directory},dst=/proof,readonly",
                    "--env",
                    "BIRBCREW_FINANCE_CONFIG=/proof/listener.json",
                    args.image,
                ]
            )
            name = child.container_id
            wait_port(child, number)
            identities.append(json.loads(command(["docker", "inspect", name]))[0]["Image"])
            assert command(["docker", "exec", name, "id", "-u"]).strip() == "10001"
            status, state = request(number, who)
            assert status == 200
            states.append(state["id"])
            command(["docker", "stop", "-t", "2", name])
            child.wait(timeout=5)
        assert states[0] == states[1] and identities[0] == identities[1]
        observed = json.loads(
            run.utility(
                [
                    "--rm",
                    "--network",
                    "none",
                    "--mount",
                    f"type=bind,src={directory},dst=/proof,readonly",
                    args.image,
                    "python",
                    "-I",
                    "-B",
                    "-c",
                    "import hashlib,json,pathlib; "
                    "print(json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest() "
                    "for p in pathlib.Path('/proof').iterdir()}))",
                ]
            )
        )
        assert observed == hashes
        return {
            "uid": 10001,
            "same_thread": states[0],
            "image": identities[0],
            "unchanged_mount_hashes": hashes,
            "replacements": 2,
        }

    case("default_image_uid10001_mount_replacement", default_image_replacement)
    ledger["database_final"] = counts()
    ledger["limitations"] = [
        "Commands, events and production cursor reconnect are absent.",
        "Session resumption was attempted but not established.",
        "Suspended generator is not socket write backpressure.",
        "Public route transport in this case is ASGI; private requests use real TLS.",
    ]


try:
    main()
except Exception as error:
    ledger["fatal"] = {"error": repr(error), "trace": traceback.format_exc()}
    print("fatal", repr(error), flush=True)
finally:
    sys.exit(run.finish().exit_code)
