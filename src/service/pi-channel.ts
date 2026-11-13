import type { Duplex } from "node:stream";

// The host and its confined Pi worker exchange newline-delimited JSON over descriptor 3. Node's own IPC
// channel is not used: one malformed line from the worker would throw out of Node's reader and end the host.
// A frame holds at most one model context: a 4 MiB checkpoint's turns, the instructions and context, and
// the tool schemas. The limit counts characters.
const frameLimit = 16 * 1024 * 1024;

export function readFrames(stream: Duplex, onFrame: (value: unknown) => void, onError: (error: Error) => void) {
  let pending: string[] = [], size = 0, failed = false;
  const fail = (error: Error) => { failed = true; pending = []; onError(error); };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    let start = 0;
    for (let end = chunk.indexOf("\n"); end >= 0 && !failed; end = chunk.indexOf("\n", start)) {
      const line = pending.join("") + chunk.slice(start, end);
      pending = []; size = 0; start = end + 1;
      let value: unknown;
      try { value = JSON.parse(line); } catch { return fail(new Error("Malformed Pi channel frame")); }
      onFrame(value);
    }
    if (failed) return;
    size += chunk.length - start;
    if (size > frameLimit) return fail(new Error("Oversized Pi channel frame"));
    if (start < chunk.length) pending.push(chunk.slice(start));
  });
}

export function writeFrame(stream: Duplex, value: unknown, done?: (error?: Error | null) => void) {
  stream.write(JSON.stringify(value) + "\n", done);
}
