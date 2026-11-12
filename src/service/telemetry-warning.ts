// Loaded by telemetry.ts only when OTLP export is configured.
const warningIntervalMs = 5 * 60_000;

// Export errors can carry the collector's address, its status text or its response body, so the warning names only
// an HTTP status or a fixed Node or OpenSSL error code such as ECONNREFUSED or DEPTH_ZERO_SELF_SIGNED_CERT.
function exportFailure(error: unknown) {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599) return `HTTP ${code}`;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)) return code;
  if (message === "Request Timeout") return "timeout";
  if (message === "Export failed with retryable status") return "HTTP 429, 502, 503 or 504";
  return "unknown error";
}

/** Reports failed exports in at most one line per interval and counts the ones it held back. */
export function exportWarning(write: (line: string) => void, now: () => number = () => performance.now()) {
  let quietUntil = -Infinity, held = 0;
  return (error: unknown) => {
    if (now() < quietUntil) { held++; return; }
    quietUntil = now() + warningIntervalMs;
    write(`birbcrew: OTLP trace export failed (${exportFailure(error)}) and its spans were dropped`
      + (held ? `; ${held} more failed since the last warning` : "") + "; the next warning comes at least 5 minutes later\n");
    held = 0;
  };
}
