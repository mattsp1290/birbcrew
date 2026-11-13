import { writeSync } from "node:fs";

type Field = string | number | boolean | null | undefined;

// JWTs (also cut or unsigned ones), other three-part tokens, bearer values, values of credential-named keys, and long
// opaque runs such as API or refresh tokens. A UUID (36 characters) stays readable.
const secretShapes: [RegExp, string][] = [
  [/eyJ[\w-]{4,}(?:\.[\w-]*){0,2}/g, "[redacted]"],
  [/[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "[redacted]"],
  [/\b(bearer|basic)(\s+)[^\s"',;]+/gi, "$1$2[redacted]"],
  [/(token|secret|password|passwd|api[_-]?key|\bkey|authorization|credential)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1$2[redacted]"],
  [/[\w+-]{40,}=*/g, "[redacted]"],
];

/**
 * One line of at most `limit` characters with token-shaped text removed.
 * `keep` chooses which part of a longer line survives. A process reports why it stopped at the end of its output.
 */
export function redact(text: string, limit = 512, keep: "start" | "end" = "start") {
  let line = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
  for (const [shape, replacement] of secretShapes) line = line.replace(shape, replacement);
  if (line.length <= limit) return line;
  return keep === "end" ? "…" + line.slice(-limit) : line.slice(0, limit) + "…";
}

/** The class, error code and a redacted message of a caught value. */
export function errorSummary(error: unknown): Record<string, Field> {
  if (!(error instanceof Error)) return { error: typeof error };
  const code = (error as { code?: unknown }).code;
  const reason = (error as { reason?: unknown }).reason;
  return {
    error: redact(error.name, 64),
    ...((typeof code === "string" || typeof code === "number") && { code: redact(String(code), 64) }),
    ...(typeof reason === "string" && { reason: redact(reason, 64) }),
    message: redact(error.message, 300),
  };
}

let write = (line: string) => { try { writeSync(2, line + "\n"); } catch {} };

/** A turn runner's stderr is closed, so it forwards its warnings to the supervisor host, which writes them. */
export function forwardWarnings(to: (line: string) => void) {
  write = to;
}

/** Writes a line that warn() built in a turn runner. */
export function relayWarning(line: string) {
  write(line);
}

/** Writes one JSON line on stderr. String fields are redacted again here, so a caller's mistake cannot leak a token. */
export function warn(event: string, fields: Record<string, Field> = {}) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, typeof value === "string" ? redact(value, 1024) : value]));
  write(JSON.stringify({ level: "warn", logger: "birbcrew", event, ...clean }));
}
