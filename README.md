# Birbcrew

A local proof of a durable coding coworker conversation using Python, Pydantic AI,
Temporal, PostgreSQL, and AG-UI.

Run `scripts/setup`, then `scripts/verify`. The verifier starts disposable local
services, generates credentials, uses an isolated Beans fixture, drives two
AG-UI SDK clients, injects process failures, and prints the evidence directory.

See [the verification procedure](docs/verification.md) for prerequisites and the
separate subscription journey. See [the design](docs/architecture.md) for state
ownership and limits. [The first milestone](docs/first-milestone.md) defines the
acceptance contract. Authentication and permissions require human review before
merge. This repository does not provide production authentication or deployment.

### Verify the Claude and Pi adapters

On Linux with Docker, run `scripts/verify-adapters`. It installs the locked
production dependencies in a fresh consumer, then runs the official AG-UI HTTP
client with external networking disabled. Each SDK answers prompts in two
independent conversations, reports a provider failure, and cancels a streaming
reply when the client disconnects. The model responses are scripted locally.

For local development, use Node 22.23.3 and run `npm ci`, `npm run typecheck`,
and `npm test`. The TypeScript fixtures exercise the adapter packages ahead of
their integration with the BirbCrew service. Package pins and rebuild
instructions are in [the adapter reference](vendor/ag-ui/README.md).

### Run durable Claude and Pi members

A member's SDK and execution profile are fixed at spawn. The TypeScript worker
uses Temporal to order turns and PostgreSQL to store the member, each
conversation's native checkpoint, and its committed replies. Claude also needs
the same private state directory when a worker is replaced.

Run `npm ci` and `npm run test:integration` on Linux with Node 22.23.3, Docker,
Python 3, and Temporal CLI 1.10.0. Claude requires Linux Landlock ABI 3 or newer. Set `TEMPORAL_CLI` if the executable is
outside PATH and `.proof/bin`. This command starts disposable services and uses
local scripted model providers. To use an approved account, follow the
[live profile guide](docs/member-profiles.md). The verifier replaces the worker, PostgreSQL
process, and Temporal server before asking both SDKs to recall earlier turns.
It also kills a worker during two model requests and checks the recorded outcomes.

For an existing local installation, set `BIRBCREW_DATABASE_URL` to a dedicated
PostgreSQL database, `BIRBCREW_TEMPORAL_ADDRESS` to the Temporal endpoint,
and `BIRBCREW_STATE_DIR` to an absolute private directory on persistent storage.
These are trusted local operator commands. The owner field comes from the local
operator. Use the fixture profile to run without provider accounts.

```sh
npm run members -- worker tests/proof/fixture-profiles.mts
```

Run the following commands in another terminal with the same database and
Temporal settings. Generate your own request and conversation UUIDs.
Substitute the member ID printed by the first command.

```sh
echo '{"ownerId":"local","requestId":"92090532-d939-43d9-847e-0e439eb74f6c","engine":"pi","profile":"fixture.v1"}' | npm run --silent members -- spawn
echo '{"ownerId":"local","memberId":"<member UUID>","conversationId":"c31bb038-d19e-46bc-a76d-a12526156a0e"}' | npm run --silent members -- open
echo '{"ownerId":"local","conversationId":"c31bb038-d19e-46bc-a76d-a12526156a0e","requestId":"d25a62d7-b003-43fb-a8a7-20ba04887508","text":"remember cedar"}' | npm run --silent members -- turn
```

Use `"engine":"claude"` at spawn to select Claude. In a fixture conversation,
send `recall` with a fresh request UUID to retrieve the remembered value. Reuse
the original request UUID and text to recover its recorded reply after a lost
acknowledgement. Each conversation admits four distinct requests. If a worker
disappears during native generation, a replacement records the uncertain outcome
and closes that conversation to further turns.

Use the [HTTP gateway guide](docs/member-gateway.md) to submit turns, decide
protected tool requests and attach independent AG-UI observers to these members.
