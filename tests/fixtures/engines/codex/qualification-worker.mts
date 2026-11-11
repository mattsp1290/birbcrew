import { fixtureThread } from "./sdk.mts";

const [home, workspace, provider, endpoint, prompt, threadId] = process.argv.slice(2);
const thread = fixtureThread(home, workspace, provider, threadId, endpoint);
let completed = false;
for await (const event of (await thread.runStreamed(prompt)).events) {
  if (event.type === "thread.started") process.send?.({threadId:event.thread_id});
  if (event.type === "turn.completed") completed = true;
  if (event.type === "turn.failed" || event.type === "error") throw new Error("Qualification turn failed");
}
if (!completed) throw new Error("Native turn ended without a completion");
