import os
import sys

import pytest

_recording = None


def _record_open(event, arguments):
    if _recording is not None and event == "open" and arguments:
        try:
            _recording.append(os.path.realpath(os.fsdecode(arguments[0])))
        except TypeError:
            pass


# An audit hook cannot be removed, so it is installed once and records only inside the fixture.
sys.addaudithook(_record_open)


@pytest.fixture
def opened_files():
    """Every path the interpreter opens while the fixture is active, from Python's own audit events.

    It lets a test state which files a code path read, and so that it read no other.
    """
    global _recording
    _recording = []
    try:
        yield _recording
    finally:
        _recording = None
