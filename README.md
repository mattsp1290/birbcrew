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
