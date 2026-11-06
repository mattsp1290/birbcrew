import json
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from birbcrew.beans import FixtureHub
from birbcrew.domain import Prompt
from birbcrew.provider import check_evidence


def test_request_identity_excludes_transport_order():
    rid = "2dc18963-f3f1-48d2-b89b-5424765f78a1"
    first = Prompt(request_id=rid, text="inspect the coding fixture")
    second = Prompt.model_validate_json(json.dumps({"text": first.text, "request_id": rid}))
    assert first.digest == second.digest
    assert first.digest != Prompt(request_id=rid, text="different").digest
    with pytest.raises(ValidationError):
        Prompt(request_id=rid, text="x" * 4001)


def test_live_gate_rejects_overage_and_stale_attestation(tmp_path):
    path = tmp_path / "account.json"
    evidence = {
        "provider": "opencode-go",
        "account_path": "owner subscription",
        "extra_usage_disabled": False,
        "eligible_coding_use": True,
        "checked_at": datetime.now(UTC).isoformat(),
        "evidence": "owner console check",
    }
    path.write_text(json.dumps(evidence))
    with pytest.raises(ValueError, match="Extra Usage"):
        check_evidence(path)
    evidence["extra_usage_disabled"] = True
    evidence["checked_at"] = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    path.write_text(json.dumps(evidence))
    with pytest.raises(ValueError, match="Current"):
        check_evidence(path)
    evidence["checked_at"] = datetime.now(UTC).isoformat()
    path.write_text(json.dumps(evidence))
    assert check_evidence(path).extra_usage_disabled


def test_beans_capture_is_scoped_clean_and_stable(tmp_path):
    hub = FixtureHub(tmp_path)
    hub.seed()
    first = hub.capture()
    second = hub.capture()
    assert first == second
    assert {n.key for n in first.notes} == {"milestone", "verification"}
    assert "UNRELATED_FIXTURE" not in first.model_dump_json()
    note = hub.hub / first.notes[0].path
    note.write_text(note.read_text() + "\nchanged")
    with pytest.raises(ValueError, match="clean"):
        hub.capture()


def test_beans_rejects_remote_before_any_mutation(tmp_path):
    hub = FixtureHub(tmp_path)
    hub.seed()
    commit = hub.git("rev-parse", "HEAD")
    hub.git("remote", "add", "origin", "https://example.invalid/private-hub")
    with pytest.raises(ValueError, match="no remotes"):
        hub.bn("birbcrew", "remember", "--key", "unsafe", "must not be written")
    assert hub.git("rev-parse", "HEAD") == commit


def test_beans_rejects_hub_symlink(tmp_path):
    other = tmp_path / "elsewhere"
    other.mkdir()
    root = tmp_path / "fixture"
    root.mkdir()
    (root / "hub").symlink_to(other, target_is_directory=True)
    with pytest.raises(ValueError, match="escaped"):
        FixtureHub(root).assert_safe()


def test_beans_ignores_inherited_git_repository(tmp_path, monkeypatch):
    foreign = tmp_path / "foreign"
    foreign.mkdir()
    monkeypatch.setenv("GIT_DIR", str(foreign))
    monkeypatch.setenv("GIT_WORK_TREE", str(foreign))
    hub = FixtureHub(tmp_path / "fixture")
    hub.seed()
    assert hub.capture().project == "birbcrew"
    assert list(foreign.iterdir()) == []


def test_live_preflight_stops_at_failed_auth(tmp_path, monkeypatch):
    import httpx

    from birbcrew import provider

    path = tmp_path / "account.json"
    path.write_text(
        json.dumps(
            {
                "provider": "opencode-go",
                "account_path": "fixture account",
                "extra_usage_disabled": True,
                "eligible_coding_use": True,
                "checked_at": datetime.now(UTC).isoformat(),
                "evidence": "fixture attestation",
            }
        )
    )
    monkeypatch.setattr(provider, "read_go_key", lambda: "disposable-key")
    calls = []

    def reject(url, **kwargs):
        calls.append(url)
        return httpx.Response(401, json={"error": {"code": "api_key_expired"}})

    monkeypatch.setattr(provider.httpx, "get", reject)
    with pytest.raises(ValueError, match="HTTP 401"):
        provider.preflight_account(path)
    assert calls == [provider.ENDPOINT + "/models"]
