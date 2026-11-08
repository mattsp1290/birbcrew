# Observed failures and remedies

These excerpts were read from the disposable proof logs. They are not passing evidence.

Source `/tmp/birbcrew-proof-ufzz2bhj/worker-1.log`.

```text
temporalio.worker.workflow_sandbox._restrictions.RestrictedWorkflowAccessError: Cannot access os.path from inside a workflow. If this is code from a module not used in a workflow or known to only be used deterministically from a workflow, mark the import as pass through.
```

Source `/tmp/birbcrew-proof-w4c8hbfm/client-a-1.log`.

```text
Agent execution failed: AGUIError: First event must be 'RUN_STARTED'
```

Source `/tmp/birbcrew-proof-087zoexv/gateway-3.log`.

```text
temporalio.client._exceptions.WorkflowUpdateRPCTimeoutOrCancelledError: Timeout or cancellation waiting for update
```

Source `/tmp/birbcrew-proof-joj6bpnu/worker-2.log`.

```text
ValueError: event_replay_conflict key=5b8bedab-7898-51c4-b6c1-b43082004912/0 type=RUN_STARTED fields=['timestamp']
```

The pinned Pydantic AI 2.66.0 implementation in
`.venv/lib/python3.13/site-packages/pydantic_ai/models/test.py`, `TestModel._request`,
contains this initial-tool-call condition. This local dependency source explains
the choice of FunctionModel for a fixture that calls tools on multiple turns.

```python
if tool_calls and not any(isinstance(m, ModelResponse) for m in messages):
```
