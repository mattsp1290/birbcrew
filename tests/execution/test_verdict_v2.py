import pytest
from pydantic import ValidationError

from birbcrew.execution.review import Verdict


@pytest.mark.parametrize('decision,blockers,notes,valid', [
    ('approved', [], [], True),
    ('approved', [], ['Nonblocking observation.'], True),
    ('approved', ['Defect.'], [], False),
    ('changes_requested', ['Defect.'], [], True),
    ('changes_requested', ['Defect.'], ['Note.'], True),
    ('changes_requested', [], [], False),
    ('approved', [], [123], False),
    ('approved', [], [''], False),
])
def test_explicit_verdict_contract(decision, blockers, notes, valid):
    value = dict(decision=decision, blocking_findings=blockers, notes=notes)
    if valid:
        assert Verdict.model_validate(value).decision == decision
    else:
        with pytest.raises(ValidationError):
            Verdict.model_validate(value)


@pytest.mark.parametrize('value', [
    {'approved': True, 'findings': ['Fine.']},
    {'decision': 'approved', 'blocking_findings': []},
    {'decision': 'approved', 'blocking_findings': [], 'notes': [], 'extra': True},
    {'decision': True, 'blocking_findings': [], 'notes': []},
])
def test_unknown_or_missing_verdict_fields_fail(value):
    with pytest.raises(ValidationError):
        Verdict.model_validate(value)
