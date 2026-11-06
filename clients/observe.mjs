import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { HttpAgent } from '@ag-ui/client';

const [configPath, conversationId, outputPath, after] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const agent = new HttpAgent({
  url: `${config.url}/conversations/${conversationId}/events${after ? `?after=${after}` : ""}`,
  threadId: conversationId,
  headers: { Authorization: `Bearer ${config.tokens.owner}` },
});
agent.subscribe({
  onEvent({ event }) {
    appendFileSync(outputPath, `${JSON.stringify(event)}\n`);
  },
  onMessagesChanged({ messages }) {
    writeFileSync(`${outputPath}.messages.json`, JSON.stringify(messages));
  },
  onRunFailed({ error }) {
    console.error(error.message);
    process.exitCode = 1;
  },
});
process.on('SIGTERM', () => {
  agent.abortRun();
  process.exit(0);
});
await agent.runAgent();
