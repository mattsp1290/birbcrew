/** Call only from a trusted backend worker, never with observer-supplied authority. */
import { TrustedContextStore, type TrustedKey } from "./trusted-context.ts";
import { runTrustedNativeTurn, type TrustedNativeProfile } from "./trusted-native.ts";

/** One durable queue head. Poll again after null or a busy/rotation response.
 * No context, prompts, native state or results need to enter Temporal history:
 * a Temporal activity wrapper should accept only key and return only request ID.
 * Text is buffered privately until commit rechecks generation and authorization.
 */
export async function runTrustedRequest(store: TrustedContextStore, key: TrustedKey, profile: TrustedNativeProfile, signal: AbortSignal) {
  const start = await store.begin(key);
  if (!start) return null;
  if (profile.engine !== start.engine || (profile.engine !== "pi" &&
      (profile.profile.ownerId !== key.ownerId || profile.profile.memberId !== start.memberId))) {
    throw new Error("Trusted native profile ownership does not match the conversation");
  }
  await store.admitted(start.claim, signal, async admitted => {
    const result = await runTrustedNativeTurn({
      engine:start.engine,threadId:start.threadId,runId:start.claim.requestId,text:start.text,
      context:start.context,binding:start.binding,checkpoint:start.checkpoint,signal:admitted,
      tools:store.manifest.map(({kind:_,...tool}) => tool),
      dispatch:call => store.dispatch(start.claim,call.nativeCallId,call.toolName,call.args,call.signal),
      onToolDelivered:call => store.acknowledge(start.claim,call.nativeCallId,call.toolName),
    },profile);
    admitted.throwIfAborted();
    await store.commit(start.claim,result.text,result.checkpoint);
  });
  return {requestId:start.claim.requestId};
}
