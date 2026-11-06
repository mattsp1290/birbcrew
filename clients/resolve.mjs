import { readFileSync } from 'node:fs';

const [configPath, conversationId, requestId, version, choice] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const response = await fetch(`${config.url}/conversations/${conversationId}/human`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${config.tokens.owner}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ request_id: requestId, version: Number(version), choice }),
});
if (!response.ok) throw new Error(`Human resolution returned HTTP ${response.status}`);
console.log(JSON.stringify({ client: 'B', resolution: await response.json() }));
