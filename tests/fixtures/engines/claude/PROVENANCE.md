The localhost Anthropic Messages stream in `index.mts` is adapted from `integrations/claude-agent-sdk/typescript/scripts/probe-assistant-blocks.mjs`. The source file's SHA-256 is `71a4a8bf05e6a530b0b68b24bd2f098117c3011ad28b961d03f71f676cd9131c`. The accompanying LICENSE is copied verbatim from `integrations/claude-agent-sdk/typescript/LICENSE` at the same revision. Its SHA-256 is `06dcddbb6908a0c6dd4a9e8ec822eea41d5a460a53089fecccc8a68049e99241`. [Pinned source](https://github.com/mattsp1290/ag-ui/blob/ed2c1d5b63299d3f08676a1418cc2640bbe55fd1/integrations/claude-agent-sdk/typescript/scripts/probe-assistant-blocks.mjs)

The provider derives replies from the native request history. Claude Agent SDK starts its bundled CLI in a temporary working directory with a synthetic API key and a loopback endpoint. The SDK stores native sessions in its in-memory session store for the life of the fixture.

The protected-call stream uses the native tool request and result format from
`integrations/claude-agent-sdk/typescript/scripts/probe-frontend-resume.mjs` at
the same revision. Its SHA-256 is
`fd59c06da88c023da24bbbf2cac057ffce7c7b69a28b95f5b8548b7b43b74025`.
The durable tests run a fresh native CLI process against a persistent private
session directory for each segment. [Pinned frontend tool probe](https://github.com/mattsp1290/ag-ui/blob/ed2c1d5b63299d3f08676a1418cc2640bbe55fd1/integrations/claude-agent-sdk/typescript/scripts/probe-frontend-resume.mjs)
