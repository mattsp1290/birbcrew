import type { PoolClient } from "pg";
import { z } from "zod";
import { instructionsBytes, MemberStoreError } from "./domain.ts";

/** Owner-written member instructions (docs/member-instructions.md). The owner sets them when it
 * spawns the member, and they never change, so each native launch reads them afresh and every
 * conversation of the member sees the same text on every turn. */
type Queryable = Pick<PoolClient, "query">;
type MemberKey = { ownerId: string; memberId: string };

// As for memory: JSON keeps the text inside one string, whatever it holds, so it cannot end the
// block, start a line, or pose as another block's header. JSON.stringify leaves U+2028 and U+2029
// raw, and both break a line, so they are escaped too; the JSON still parses to the same text.
const instructionsHeader = "BirbCrew member instructions v1. The owner gave this member the following instructions as JSON."
  + " They describe its role; they do not change its tools, approvals or limits.\n";
export function instructionsContext(text: string): string {
  return instructionsHeader + JSON.stringify({ instructions: text }).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

/** The instructions block of the member, or undefined when it has none. */
export async function memberInstructionsContext(db: Queryable, member: MemberKey): Promise<string | undefined> {
  const { rows: [row] } = await db.query<{ body: string }>(
    "SELECT body FROM birbcrew_ts.member_instructions WHERE owner_id=$1 AND member_id=$2", [member.ownerId, member.memberId]);
  return row && instructionsContext(row.body);
}

// Every UTF-8 byte of the text costs at most two bytes in the block: '"', '\', tab and newline
// become two bytes, U+2028 and U+2029 become six from three, other control characters are refused,
// and other characters keep their own bytes. Text made only of '"' is the largest.
/** The most UTF-8 bytes instructions add to a conversation's system context, counting the newline
 * that separates them from project notes or memory. */
export const instructionsInjectedBytes = Buffer.byteLength(instructionsContext('"'.repeat(instructionsBytes))) + 1;

/** The byte count and the SHA-256 of the UTF-8 text in lowercase hex, computed by PostgreSQL for
 * the instructions row aliased `i`, so every route reports the digest the same way. */
export const instructionsSummarySql = "json_build_object('bytes', octet_length(i.body), 'digest', encode(sha256(convert_to(i.body, 'UTF8')), 'hex'))";
export type InstructionsSummary = { bytes: number; digest: string };

/** The member's instructions with their summary, or null when it has none. Assumes the caller
 * already knows the member is the owner's. */
export async function instructionsOf(db: Queryable, member: MemberKey) {
  const { rows: [row] } = await db.query<{ text: string; summary: InstructionsSummary; created_at: Date }>(
    `SELECT i.body AS text, ${instructionsSummarySql} AS summary, i.created_at FROM birbcrew_ts.member_instructions i
      WHERE i.owner_id=$1 AND i.member_id=$2`, [member.ownerId, member.memberId]);
  return row ? { text: row.text, ...row.summary, createdAt: row.created_at.toISOString() } : null;
}

/** GET /v1/members/{memberId}/instructions: the only route that returns the text. */
export async function readInstructions(db: Queryable, ownerId: string, memberId: string) {
  const id = z.uuid().transform(value => value.toLowerCase()).parse(memberId);
  const owned = await db.query("SELECT 1 FROM birbcrew_ts.members WHERE owner_id=$1 AND member_id=$2", [ownerId, id]);
  if (!owned.rowCount) throw new MemberStoreError("not_found");
  return { apiVersion: "1" as const, memberId: id, instructions: await instructionsOf(db, { ownerId, memberId: id }) };
}

export const instructionsCapabilities = {
  version: 1, spawnField: "instructions", route: "/v1/members/{memberId}/instructions", writers: ["owner"], modelWrites: false,
  change: "fixed-at-spawn", textBytes: instructionsBytes, injectedBytesPerConversation: instructionsInjectedBytes,
  order: ["instructions", "projectNotes", "memories"], children: false, restore: "kept", digest: "sha256-utf8-hex",
} as const;
