import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
export function codexExecutable() {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
  if (process.platform !== "linux" || !arch) throw new Error("Codex member requires Linux arm64 or x64");
  const pkg = dirname(require.resolve("@openai/codex-linux-" + process.arch + "/package.json"));
  return join(pkg, "vendor", arch + "-unknown-linux-musl", "bin", "codex");
}
