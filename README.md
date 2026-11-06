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
