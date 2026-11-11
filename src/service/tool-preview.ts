// SDKs may repeat partial objects. Only the schema prefix and a matching public UUID can advance the observer.
export function toolPreviewReporter(requestId: string, publish?: (nativeCallId: string, matchedOperation: boolean) => void) {
  let reported: "prefix" | "operation" | undefined;
  return (nativeCallId: string, operation: unknown) => {
    const matched = operation === requestId;
    if (reported === "operation" || (reported === "prefix" && !matched)) return;
    reported = matched ? "operation" : "prefix";
    publish?.(nativeCallId, matched);
  };
}
