import { HttpAgent } from "@ag-ui/client";
import { connection, type ConnectionOptions } from "./config.js";
import { conversationIdentitySchema, observerPath } from "./contract.js";
export function createCrewObserver(options: ConnectionOptions & { readonly conversationId: string }): HttpAgent {
  const { baseUrl, headers } = connection(options);
  const { conversationId } = conversationIdentitySchema.parse({ conversationId: options.conversationId });
  return new HttpAgent({ url: baseUrl + observerPath.replace("{conversationId}", conversationId), threadId: conversationId, headers });
}
