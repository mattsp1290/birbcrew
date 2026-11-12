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

/** Parse once at a process entry point and pass the result inward. Without TLS variables the connection stays plaintext. */
export function temporalSettings(env: NodeJS.ProcessEnv): TemporalSettings {
  const tls = Object.fromEntries(Object.entries(tlsVariables)
    .flatMap(([field, name]) => env[name] === undefined ? [] : [[field, env[name]]]));
  const parsed = temporalSettingsSchema.safeParse({
    address: env.BIRBCREW_TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
    namespace: env.BIRBCREW_TEMPORAL_NAMESPACE ?? "default",
    ...(Object.keys(tls).length && { tls }),
  });
  if (parsed.success) return parsed.data;
  // Name the variables only; their values can be private paths.
  const names = new Set(parsed.error.issues.map(({ path }) => variables[String(path.at(-1))]));
  throw new Error(`Invalid Temporal settings: ${[...names].join(", ")}. TLS needs all four TLS variables, with absolute file paths.`);
}

/** Options for both client and worker connections. Certificate and key bytes are read here and never logged. */
export async function temporalConnection(settings: TemporalSettings): Promise<{ address: string; tls?: TLSConfig }> {
  if (!settings.tls) return { address: settings.address };
  const { caPath, certificatePath, privateKeyPath, serverName } = settings.tls;
  const [ca, crt, key] = await Promise.all([caPath, certificatePath, privateKeyPath].map((path) => readFile(path)));
  return { address: settings.address, tls: { serverNameOverride: serverName, serverRootCACertificate: ca, clientCertPair: { crt, key } } };
}
