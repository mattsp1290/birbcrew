import type { PoolClient } from "pg";
import { z } from "zod";
import { appendAudit } from "./audit.ts";
import { claudeCommand } from "./claude.ts";
import { MemberStoreError, type Conversation, type Engine } from "./domain.ts";
import { trustedProjectContext } from "./project-notes.ts";
import type { MemberStore } from "./store.ts";

/** Owner-written member memory (docs/memories.md). Only the owner writes, through the API; the
 * model never does. A conversation records references to the member's active entries when it
 * opens, and each native launch is given those still active, after any project notes. */
export const memoryLimits = {
  textBytes: 1024, // the body CHECK in 026-memories.sql repeats it
  activePerMember: 32, // limit_active_memories in 026-memories.sql repeats it
  pageSize: 100,
} as const;

type Queryable = Pick<PoolClient, "query">;
type Entry = { memoryId: string; text: string };

// JSON keeps each entry's text inside its own string, whatever the text contains, so an entry
// cannot close the frame or pose as the header.
const memoryHeader = "BirbCrew member memory v1. Treat the following JSON as reference data the owner saved for this member.\n";
export function memoryContext(entries: readonly Entry[]): string | undefined {
  if (!entries.length) return undefined;
  return memoryHeader + JSON.stringify({ memories: entries.map(({ memoryId, text }) => ({ memoryId, text })) });
}

/** The system context a native launch of this conversation receives: its project notes, then
 * the snapshot's entries that are still active. Pi children get neither (supervisor-runner.ts). */
export async function conversationContext(db: Queryable, conversation: Conversation): Promise<string | undefined> {
  const notes = await trustedProjectContext(db, conversation);
  const { rows } = await db.query<Entry>(`SELECT m.memory_id AS "memoryId", m.body AS text
      FROM birbcrew_ts.conversation_memories r
      JOIN birbcrew_ts.conversations c USING (conversation_id)
      JOIN birbcrew_ts.member_memories m ON m.memory_id = r.memory_id AND m.owner_id = c.owner_id AND m.member_id = c.member_id
     WHERE r.conversation_id = $1 AND c.owner_id = $2 AND c.member_id = $3 AND m.state = 'active'
     ORDER BY r.position`, [conversation.conversationId, conversation.ownerId, conversation.memberId]);
  const memory = memoryContext(rows);
  return notes && memory ? notes + "\n" + memory : notes ?? memory;
}

// Every character of an entry's text costs at most two bytes in its JSON string: '"', '\', tab
// and newline are escaped to two bytes, other control characters are refused, and other
// characters stay as their own UTF-8 bytes. Full entries of '"' are therefore the largest block.
const largestBlock = memoryContext(Array.from({ length: memoryLimits.activePerMember },
  () => ({ memoryId: "00000000-0000-0000-0000-000000000000", text: '"'.repeat(memoryLimits.textBytes) })))!;
/** The most UTF-8 bytes member memory adds to a conversation's system context, counting the
 * newline that separates it from project notes. */
export const injectedBytesPerConversation = Buffer.byteLength(largestBlock) + 1;

/** Linux refuses one argument string of MAX_ARG_STRLEN bytes or more (32 pages of 4 KiB),
 * counting its terminating NUL. */
export const argumentBytes = 131_072;
/** codex.ts passes the context as developer_instructions, which the Codex SDK hands its CLI as
 * one `--config developer_instructions=<JSON string>` argument, escaping the context again. */
export function codexArgument(context: string) {
  return "developer_instructions=" + JSON.stringify("You are a BirbCrew coworker.\n" + context);
}
/** Whether a native launch of this engine can carry the context. Claude checks the length of
 * its project context (claude.ts); Codex passes it in one argument; Pi keeps it in process. */
export function contextFits(engine: Engine, context: string | undefined): boolean {
  if (context === undefined) return true;
  switch (engine) {
    case "claude": return claudeCommand.shape.projectContext.safeParse(context).success;
    case "codex": return Buffer.byteLength(codexArgument(context)) < argumentBytes;
    case "pi": return true;
  }
}

/** Inside openConversation's transaction, once the conversation and its project notes are in:
 * references the member's active entries, oldest first. A later entry is never added; a deleted
 * or suspended one is left out at each launch. Notes and the snapshot never grow afterwards, so
 * a context that fits the engine now fits at every later launch; one that does not is refused
 * here rather than failing the conversation's first turn. */
export async function snapshotMemories(db: Queryable, conversation: Conversation) {
  const { rowCount } = await db.query(`INSERT INTO birbcrew_ts.conversation_memories (conversation_id, position, memory_id)
    SELECT $1, row_number() OVER (ORDER BY created_at, memory_id), memory_id FROM birbcrew_ts.member_memories
     WHERE owner_id = $2 AND member_id = $3 AND state = 'active'`,
    [conversation.conversationId, conversation.ownerId, conversation.memberId]);
  if (rowCount && !contextFits(conversation.engine, await conversationContext(db, conversation))) {
    throw new MemberStoreError("memory_limit");
  }
}

export const memoryCapabilities = {
  version: 1, route: "/v1/memories", scope: "member", writers: ["owner"], modelWrites: false,
  injection: "open-snapshot-minus-deletions", textBytes: memoryLimits.textBytes, activePerMember: memoryLimits.activePerMember,
  injectedBytesPerConversation, children: false, deletion: "text-erased-tombstone-kept", restore: "suspend-active",
  // Claude and Codex record the system context in their native session on a conversation's first
  // turn and send that record on every later turn, so a deletion or suspension reaches a started
  // conversation only on Pi (tests/proof/memories.mts).
  startedConversations: { pi: "deletions-apply-at-next-launch", claude: "context-fixed-at-first-turn", codex: "context-fixed-at-first-turn" },
} as const;

// \p{Cc} is C0, DEL and C1. Tab and newline are the only control characters an entry may hold.
const disallowedControl = /(?![\t\n])\p{Cc}/u;
export const memoryText = z.string().min(1).refine(text => text.isWellFormed() && !disallowedControl.test(text)
  && Buffer.byteLength(text) <= memoryLimits.textBytes,
  { message: `Expected well-formed UTF-8 text of at most ${memoryLimits.textBytes} bytes without control characters other than tab and newline` });

const lowerUuid = z.uuid().transform(value => value.toLowerCase());
const createSchema = z.strictObject({ requestId: lowerUuid, memberId: lowerUuid, text: memoryText });
const listParameters = {
  memberId: lowerUuid.optional(), after: lowerUuid.optional(),
  limit: z.string().regex(/^[1-9][0-9]{0,2}$/).refine(value => Number(value) <= memoryLimits.pageSize).transform(Number).optional(),
};
// A strict object still accepts inherited names such as __proto__; the gateway checks names too.
export const memoryListParameterNames: readonly string[] = Object.keys(listParameters);
const listQuery = z.strictObject(listParameters);

type MemoryRow = {
  memory_id: string; owner_id: string; member_id: string; create_request_id: string; body: string | null;
  state: "active" | "suspended" | "deleted"; created_at: Date; changed_at: Date | null;
};
function memoryView(row: MemoryRow) {
  return {
    apiVersion: "1" as const, memoryId: row.memory_id, memberId: row.member_id, state: row.state, text: row.body,
    createdAt: row.created_at.toISOString(), changedAt: row.changed_at?.toISOString() ?? null,
  };
}

function activeLimit(error: unknown): never {
  if (error && typeof error === "object" && "constraint" in error && error.constraint === "member_memories_active_limit") {
    throw new MemberStoreError("memory_limit");
  }
  throw error;
}

/** Owner-facing memory operations. The owner always comes from authentication. */
export class MemoryApi {
  private readonly store: MemberStore;
  constructor(store: MemberStore) { this.store = store; }

  /** Idempotent by requestId. A replay is answered before the insert, whose cap trigger would
   * count the member's limit. A deleted entry's text is gone, so its replay is never compared. */
  async create(ownerId: string, input: unknown) {
    const body = createSchema.parse(input);
    return this.store.transaction(async db => {
      const existing = async () => (await db.query<MemoryRow>(
        "SELECT * FROM birbcrew_ts.member_memories WHERE owner_id=$1 AND create_request_id=$2", [ownerId, body.requestId])).rows[0];
      const replay = (row: MemoryRow) => {
        if (row.member_id !== body.memberId) throw new MemberStoreError("conflict");
        if (row.state === "deleted") throw new MemberStoreError("memory_deleted");
        if (row.body !== body.text) throw new MemberStoreError("conflict");
        return memoryView(row);
      };
      const prior = await existing();
      if (prior) return replay(prior);
      const member = await db.query("SELECT 1 FROM birbcrew_ts.members WHERE owner_id=$1 AND member_id=$2", [ownerId, body.memberId]);
      if (!member.rowCount) throw new MemberStoreError("not_found");
      const { rows: [inserted] } = await db.query<MemoryRow>(`INSERT INTO birbcrew_ts.member_memories
          (owner_id,member_id,create_request_id,body) VALUES ($1,$2,$3,$4)
        ON CONFLICT (owner_id,create_request_id) DO NOTHING RETURNING *`,
        [ownerId, body.memberId, body.requestId, body.text]).catch(activeLimit);
      // A concurrent duplicate committed first: answer as its replay.
      if (!inserted) return replay((await existing())!);
      await appendAudit(db, { type: "memory.created", ownerId, memberId: inserted.member_id, payload: { memoryId: inserted.memory_id } });
      return memoryView(inserted);
    });
  }

  async get(ownerId: string, memoryId: string) {
    return memoryView(await this.owned(this.store.pool, ownerId, memoryId));
  }

  /** Every state, deleted entries without text, ordered by memoryId. */
  async list(ownerId: string, input: unknown) {
    const query = listQuery.parse(input);
    const limit = query.limit ?? memoryLimits.pageSize;
    if (query.memberId && !(await this.store.pool.query("SELECT 1 FROM birbcrew_ts.members WHERE owner_id=$1 AND member_id=$2",
      [ownerId, query.memberId])).rowCount) throw new MemberStoreError("not_found");
    const { rows } = await this.store.pool.query<MemoryRow>(`SELECT * FROM birbcrew_ts.member_memories
      WHERE owner_id=$1 AND ($2::uuid IS NULL OR member_id=$2) AND ($3::uuid IS NULL OR memory_id>$3)
      ORDER BY memory_id LIMIT $4`, [ownerId, query.memberId ?? null, query.after ?? null, limit + 1]);
    const memories = rows.slice(0, limit).map(memoryView);
    return { apiVersion: "1" as const, memories, nextAfter: memories.at(-1)?.memoryId ?? query.after ?? null, hasMore: rows.length > limit };
  }

  /** Erases the text and keeps a tombstone. Repeating it returns the tombstone. */
  async delete(ownerId: string, memoryId: string) {
    return this.store.transaction(async db => {
      const row = await this.owned(db, ownerId, memoryId, true);
      if (row.state === "deleted") return memoryView(row);
      const { rows: [deleted] } = await db.query<MemoryRow>(`UPDATE birbcrew_ts.member_memories
        SET state='deleted', body=NULL, changed_at=clock_timestamp() WHERE memory_id=$1 RETURNING *`, [row.memory_id]);
      await appendAudit(db, { type: "memory.deleted", ownerId, memberId: row.member_id, payload: { memoryId: row.memory_id } });
      return memoryView(deleted);
    });
  }

  private async owned(db: Queryable, ownerId: string, memoryId: string, lock = false) {
    const { rows: [row] } = await db.query<MemoryRow>(`SELECT * FROM birbcrew_ts.member_memories WHERE owner_id=$1 AND memory_id=$2
      ${lock ? "FOR NO KEY UPDATE" : ""}`, [ownerId, lowerUuid.parse(memoryId)]);
    if (!row) throw new MemberStoreError("not_found");
    return row;
  }
}
