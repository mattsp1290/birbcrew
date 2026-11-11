"""Inspect real SDK requests for conversations bound to different projects in the same hub."""

import hashlib
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4


def verify_notes(runtime, current, worker, command, wait_until, sql, directory, env):
    root = directory / "beans-installation"
    hub = root / "hub"
    hub.mkdir(parents=True)
    git_env = {**env, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
               "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache")}
    def git(*args):
        return subprocess.check_output(["git", "-C", str(hub), *args], env=git_env)
    git("init", "-q", "-b", "main")
    git("config", "user.name", "BirbCrew fixture")
    git("config", "user.email", "fixture@localhost")
    git("commit", "--allow-empty", "-qm", "Initialize fixture")

    def bn(project, *args):
        result = subprocess.run(
            ["bn", "--hub", str(hub), "--branch", "main", "--actor", "proof", "--project", project,
             "--json", "--no-fetch", "--no-sync", *args], cwd=root, env=git_env, capture_output=True, check=True)
        return json.loads(result.stdout)

    projects = {}
    for project in ["release", "support", "unrelated"]:
        bn(project, "project", "create", project)
        projects[project] = {key: "BIRBNOTE_" + uuid4().hex.upper() for key in ["first", "second"]}
        for key, body in projects[project].items():
            bn(project, "remember", "--key", key, body)
    commit = git("rev-parse", "HEAD").decode().strip()
    owners = {project: "notes-" + str(uuid4()) for project in ["release", "support"]}
    config = directory / "installations.json"
    config.write_text(json.dumps({owner: {"root": str(root), "actor": "proof", "project": project}
                                  for project, owner in owners.items()}))
    env["BIRBCREW_NOTE_INSTALLATIONS"] = str(config)
    evidence = directory / "note-evidence.jsonl"
    def observations():
        return [json.loads(line) for line in evidence.read_text().splitlines()] if evidence.exists() else []
    start = len(observations())
    cases = []
    with ThreadPoolExecutor(max_workers=2) as calls:
        for project, engine in [("release", "claude"), ("support", "pi")]:
            owner = owners[project]
            member = command("spawn", {"ownerId": owner, "requestId": str(uuid4()), "engine": engine,
                                       "profile": "fixture.approval.v1"})
            key = {"ownerId": owner, "conversationId": str(uuid4())}
            opening = {**key, "memberId": member["memberId"]}
            if project == "release":
                forbidden = {**opening, "conversationId": str(uuid4())}
                (hub / "uncommitted").touch()
                command("open", forbidden, fail=True)
                (hub / "uncommitted").unlink()
                git("remote", "add", "origin", str(root))
                command("open", forbidden, fail=True)
                git("remote", "remove", "origin")
                assert sql("SELECT count(*) FROM birbcrew_ts.conversations WHERE conversation_id='" +
                           forbidden["conversationId"] + "'") == "0"
            command("open", opening)
            scope = " WHERE conversation_id='" + key["conversationId"] + "'"
            capture_sql = "SELECT capture FROM birbcrew_ts.conversation_notes" + scope
            capture = json.loads(sql(capture_sql))
            assert (capture["actor"], capture["project"], capture["commit"]) == ("proof", project, commit)
            assert {n["key"]: n["body"] for n in capture["notes"]} == projects[project]
            for n in capture["notes"]:
                assert n["updated"]["seconds"] > 0 and n["path"].startswith("projects/" + project + "/")
                assert n["fileSha256"] == hashlib.sha256(git("show", commit + ":" + n["path"])).hexdigest()
                assert n["contentSha256"] == hashlib.sha256(n["body"].encode()).hexdigest()
            request = str(uuid4())
            pending = calls.submit(command, "turn", {**key, "requestId": request, "text": "record " + request})
            cases.append((project, engine, key, opening, scope, capture_sql, capture, pending))
        wait_until(lambda: all(sql("SELECT count(*) FROM birbcrew_ts.paused_segments" + case[4]) == "1"
                               for case in cases), "both project-scoped tools paused")
        def check_provider(offset, continuation):
            rows = observations()[offset:]
            for project, engine, *_ in cases:
                matching = [r for r in rows if r["engine"] == engine]
                assert len(matching) == 1, matching
                row = matching[0]
                assert row["continuation"] is continuation and row["messages"] == [], row
                assert row["system"] == sorted(projects[project].values()), row
        check_provider(start, False)
        resume = len(observations())
        hub.rename(root / "removed-hub")
        current.kill()
        current.wait(timeout=10)
        replacement = worker(runtime)
        for _, engine, key, opening, scope, capture_sql, capture, pending in cases:
            command("open", opening)
            proposal, = command("pending", key)
            decision = {k: proposal[k] for k in ("ownerId", "memberId", "conversationId", "requestId",
                        "nativeCallId", "invocationId", "approvalId", "version", "argumentDigest")}
            command("decide", {**decision, "choice": "deny"})
            reply = pending.result(timeout=60)["text"]
            assert (reply == "denied" if engine == "claude" else
                    json.loads(reply.removeprefix("settled "))["kind"] == "denied")
            assert json.loads(sql(capture_sql)) == capture
            for table in ["public_snapshots", "public_events"]:
                public = sql("SELECT to_jsonb(t) FROM birbcrew_ts." + table + " t" + scope)
                assert public and "BIRBNOTE_" not in public
        check_provider(resume, True)
    del env["BIRBCREW_NOTE_INSTALLATIONS"]
    print("Claude and Pi received only their two frozen project notes before and after worker replacement.", flush=True)
    return replacement
