import { conversationKey, engineSchema, MemberStoreError, openSchema, spawnSchema } from "./domain.ts";
import type { MemberStore } from "./store.ts";

// Exactly the historical DTO, not arbitrary extra keys. Pending activities retain
// their original payload on retry, even after the workflow caller is corrected.
const legacyProgress = conversationKey.extend({
  memberId: openSchema.shape.memberId,
  engine: engineSchema,
  profile: spawnSchema.shape.profile,
});

export function progressActivity(store: MemberStore) {
  return async (input: unknown) => {
    const narrow = conversationKey.safeParse(input);
    if (narrow.success) return store.conversationProgress(narrow.data);
    const legacy = legacyProgress.parse(input);
    const key = { ownerId: legacy.ownerId, conversationId: legacy.conversationId };
    const actual = await store.getConversation(key);
    if (actual.memberId !== legacy.memberId || actual.engine !== legacy.engine || actual.profile !== legacy.profile) {
      throw new MemberStoreError("conflict");
    }
    return store.conversationProgress(key);
  };
}
