import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { temporalConnection, temporalSettings } from "../../src/service/temporal-config.ts";

const tlsEnv = (dir: string) => ({
  BIRBCREW_TEMPORAL_TLS_CA_PATH: join(dir, "ca.pem"),
  BIRBCREW_TEMPORAL_TLS_CERTIFICATE_PATH: join(dir, "client.pem"),
  BIRBCREW_TEMPORAL_TLS_PRIVATE_KEY_PATH: join(dir, "client.key"),
  BIRBCREW_TEMPORAL_TLS_SERVER_NAME: "temporal.example.internal",
});

test("absent settings keep the previous plaintext default endpoint and namespace", async () => {
  const settings = temporalSettings({});
  assert.deepEqual(settings, { address: "127.0.0.1:7233", namespace: "default" });
  assert.deepEqual(await temporalConnection(settings), { address: "127.0.0.1:7233" });
  assert.deepEqual(temporalSettings({ BIRBCREW_TEMPORAL_ADDRESS: "temporal:7233" }), { address: "temporal:7233", namespace: "default" });
});

test("namespace and mTLS files map onto the SDK connection options", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "birb-temporal-tls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "ca.pem"), "ca bytes");
  await writeFile(join(dir, "client.pem"), "certificate bytes");
  await writeFile(join(dir, "client.key"), "key bytes", { mode: 0o600 });
  const settings = temporalSettings({ BIRBCREW_TEMPORAL_ADDRESS: "10.0.0.5:7233", BIRBCREW_TEMPORAL_NAMESPACE: "forge", ...tlsEnv(dir) });
  assert.equal(settings.namespace, "forge");
  const options = await temporalConnection(settings);
  assert.equal(options.address, "10.0.0.5:7233");
  assert.equal(options.tls?.serverNameOverride, "temporal.example.internal");
  assert.equal(Buffer.from(options.tls!.serverRootCACertificate!).toString(), "ca bytes");
  assert.equal(Buffer.from(options.tls!.clientCertPair!.crt).toString(), "certificate bytes");
  assert.equal(Buffer.from(options.tls!.clientCertPair!.key).toString(), "key bytes");
});

test("partial or relative TLS settings fail closed without echoing values", () => {
  const dir = "/run/secrets/private-temporal-dir";
  const full = tlsEnv(dir);
  for (const missing of Object.keys(full) as (keyof typeof full)[]) {
    const env: Record<string, string> = { ...full };
    delete env[missing];
    assert.throws(() => temporalSettings(env), (error: Error) => error.message.includes(missing) && !error.message.includes(dir));
  }
  assert.throws(() => temporalSettings({ ...full, BIRBCREW_TEMPORAL_TLS_PRIVATE_KEY_PATH: "client.key" }),
    (error: Error) => error.message.includes("BIRBCREW_TEMPORAL_TLS_PRIVATE_KEY_PATH") && !error.message.includes("client.key"));
  assert.throws(() => temporalSettings({ BIRBCREW_TEMPORAL_NAMESPACE: "" }), /BIRBCREW_TEMPORAL_NAMESPACE/);
  assert.throws(() => temporalSettings({ BIRBCREW_TEMPORAL_ADDRESS: "" }), /BIRBCREW_TEMPORAL_ADDRESS/);
});

test("unreadable TLS files reject the connection instead of falling back to plaintext", async () => {
  const settings = temporalSettings(tlsEnv("/nonexistent-birbcrew-temporal-tls"));
  await assert.rejects(temporalConnection(settings), { code: "ENOENT" });
});
