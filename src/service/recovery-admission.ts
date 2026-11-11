import type { Pool, PoolClient, Client } from 'pg';
export async function requireRecoveryActive(db:Pool|PoolClient|Client) {
 if(!(await db.query("SELECT 1 FROM birbcrew_ts.recovery_control WHERE singleton AND phase='active'")).rowCount) throw new Error('Installation is held for recovery');
}
/** Call inside the native lifetime transaction BEFORE checking admission. */
export async function acquireRecoveryNativeLease(db:PoolClient|Client) {
 await db.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('birbcrew.recovery.native',0))");
 await requireRecoveryActive(db);
}
