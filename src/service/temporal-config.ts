import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { TLSConfig } from "@temporalio/client";
import { z } from "zod";

const absolutePath = z.string().refine(isAbsolute);
const tlsVariables = {
  caPath: "BIRBCREW_TEMPORAL_TLS_CA_PATH",
  certificatePath: "BIRBCREW_TEMPORAL_TLS_CERTIFICATE_PATH",
  privateKeyPath: "BIRBCREW_TEMPORAL_TLS_PRIVATE_KEY_PATH",
  serverName: "BIRBCREW_TEMPORAL_TLS_SERVER_NAME",
} as const;
const variables: Record<string, string> = { address: "BIRBCREW_TEMPORAL_ADDRESS", namespace: "BIRBCREW_TEMPORAL_NAMESPACE", ...tlsVariables };

export const temporalSettingsSchema = z.strictObject({
  address: z.string().min(1),
  namespace: z.string().min(1),
  tls: z.strictObject({
    caPath: absolutePath, certificatePath: absolutePath, privateKeyPath: absolutePath, serverName: z.string().min(1),
  }).optional(),
});
export type TemporalSettings = z.infer<typeof temporalSettingsSchema>;

/** Names only the offending variables, never their values or file contents, so every process may print it. */
export class TemporalSettingsError extends Error {}

export function temporalSettings(env: NodeJS.ProcessEnv): TemporalSettings {
  const tls = Object.fromEntries(Object.entries(tlsVariables)
    .flatMap(([field, name]) => env[name] === undefined ? [] : [[field, env[name]]]));
  const parsed = temporalSettingsSchema.safeParse({
    address: env.BIRBCREW_TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
    namespace: env.BIRBCREW_TEMPORAL_NAMESPACE ?? "default",
    ...(Object.keys(tls).length && { tls }),
  });
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(({ path }) => path);
  const names = [...new Set(issues.map((path) => variables[String(path.at(-1))]))];
  throw new TemporalSettingsError(`Invalid Temporal settings: ${names.join(", ")}` +
    (issues.some((path) => path[0] === "tls") ? ". TLS needs all four TLS variables, with absolute file paths." : ""));
}

export async function temporalConnectionOptions(settings: TemporalSettings): Promise<{ address: string; tls?: TLSConfig }> {
  if (!settings.tls) return { address: settings.address };
  const { caPath, certificatePath, privateKeyPath, serverName } = settings.tls;
  const read = (path: string, name: string) => readFile(path).catch((error: NodeJS.ErrnoException) => {
    throw new TemporalSettingsError(`Cannot read ${name} (${error.code ?? "error"})`);
  });
  const [ca, crt, key] = await Promise.all([read(caPath, tlsVariables.caPath), read(certificatePath, tlsVariables.certificatePath),
    read(privateKeyPath, tlsVariables.privateKeyPath)]);
  return { address: settings.address, tls: { serverNameOverride: serverName, serverRootCACertificate: ca, clientCertPair: { crt, key } } };
}
