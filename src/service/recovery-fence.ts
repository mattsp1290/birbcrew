import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const identity = z.strictObject({ installation: z.uuid(), instance: z.uuid(), generation: z.uuid().nullable(), phase: z.enum(['active','preparing','held','restored']) });
export type FenceIdentity = z.infer<typeof identity>;
const storedEpoch = z.strictObject({ epoch: z.number().int().nonnegative() });
const missing = (e: unknown) => e instanceof Error && 'code' in e && e.code === 'ENOENT';
/** Restored timeline e draws audit IDs from [e<<44, (e+1)<<44); below this the last range ends within 2^63-1. */
export const fenceEpochLimit = 2 ** 19;
/** A refusal whose message is safe to show the operator: no connection strings, paths or provider output. */
export class RecoveryRefusedError extends Error {
  constructor(message: string) { super(message); this.name = 'RecoveryRefusedError'; }
}
/** Implement this interface using a linearizable authority shared by both hosts.
 * Never put its state in a recovery bundle or restore it from a snapshot. */
export interface RecoveryFence {
  initialize(installation: string, instance: string): Promise<void>;
  hold(installation: string, instance: string, generation: string): Promise<void>;
  seal(installation: string, instance: string, generation: string): Promise<void>;
  verify(installation: string, instance: string, generation: string): Promise<void>;
  /** Moves authority from the held source to target and returns the authority epoch, which
   * orders restored audit identities (recovery.ts acceptRestoreImpl). The move sets it to
   * max(epoch + 1, minimumEpoch); a retried transfer to the same target returns it, raised
   * to minimumEpoch if lower; nothing lowers it. When the result would reach fenceEpochLimit,
   * throw before changing anything, so authority stays with the source. */
  transfer(installation: string, source: string, target: string, generation: string, minimumEpoch: number): Promise<number>;
  verifyActivation(installation: string, instance: string, generation: string): Promise<void>;
  activate(installation: string, instance: string, generation: string): Promise<void>;
}
/** Private shared POSIX filesystem authority. Atomic mkdir/rename semantics required.
 * Lock debris after a crash fails closed; an operator must establish no owner is
 * running before removing it. NFS semantics and arbitrary clones are not claimed. */
export class FileRecoveryFence implements RecoveryFence {
  readonly directory: string;
  constructor(directory: string) { this.directory=directory; if (!isAbsolute(directory)) throw new Error('Fence requires an absolute private shared directory'); }
  // The epoch lives in epoch.json, beside a state.json that earlier releases parse strictly, so
  // a rolled-back release still reads the fence. It ignores epoch.json, and a missing file reads
  // as 0. An epoch left behind by transfers an earlier release made is harmless: such a release
  // draws no audit IDs, and acceptance raises the epoch past every ID in the restored database.
  private async change(run: (old: FenceIdentity | null, epoch: number) => FenceIdentity & { epoch?: number }) {
    await mkdir(this.directory, {recursive:true,mode:0o700});
    const lock=join(this.directory,'lock');
    const syncDirectory=async()=>{const handle=await open(this.directory,'r');try{await handle.sync();}finally{await handle.close();}};
    await mkdir(lock,{mode:0o700});
    await syncDirectory(); // no stale-lock timeout: never steal a live owner
    const temporary=join(this.directory,`.state-${randomUUID()}`);
    const temporaryEpoch=join(this.directory,`.epoch-${randomUUID()}`);
    try {
      let old: FenceIdentity|null=null;
      try { old=identity.parse(JSON.parse(await readFile(join(this.directory,'state.json'),'utf8'))); }
      catch(e) { if (!missing(e)) throw e; }
      let epoch=0;
      try { epoch=storedEpoch.parse(JSON.parse(await readFile(join(this.directory,'epoch.json'),'utf8'))).epoch; }
      catch(e) { if (!missing(e)) throw e; }
      const {epoch:raised=epoch,...state}=run(old,epoch);
      const next=identity.parse(state);
      if (raised!==epoch) {
        if (!Number.isSafeInteger(raised)||raised<epoch) throw new Error('Fence epoch cannot fall');
        // Before the state that moves authority: a crash between leaves the epoch higher than needed, never lower.
        await writeFile(temporaryEpoch,JSON.stringify({epoch:raised}),{mode:0o600,flag:'wx',flush:true});
        await rename(temporaryEpoch,join(this.directory,'epoch.json'));
        await syncDirectory();
      }
      await writeFile(temporary,JSON.stringify(next),{mode:0o600,flag:'wx',flush:true});
      await rename(temporary,join(this.directory,'state.json'));
      await syncDirectory(); // ownership transfer must be durable before returning
    } finally { await rm(temporary,{force:true}); await rm(temporaryEpoch,{force:true}); await rm(lock,{recursive:true}); await syncDirectory(); }
  }
  async initialize(installation:string,instance:string) {
    await this.change(old=>{if(old && (old.installation!==installation||old.instance!==instance)) throw new Error('Fence already belongs to another installation');return old??{installation,instance,generation:null,phase:'active'};});
  }
  async hold(installation:string,instance:string,generation:string) {
    await this.change(old=>{if(!old||old.installation!==installation||old.instance!==instance||(old.phase!=='active'&&old.generation!==generation)) throw new Error('Source is fenced'); return old.phase==='held'?old:{...old,generation,phase:'preparing'};});
  }
  async seal(installation:string,instance:string,generation:string) {
    await this.change(old=>{if(!old||old.installation!==installation||old.instance!==instance||old.generation!==generation||!['preparing','held'].includes(old.phase)) throw new Error('Source preparation mismatch');return {...old,phase:'held'};});
  }
  async verify(installation:string,instance:string,generation:string) {
    await this.change(old=>{if(!old||old.installation!==installation||old.instance!==instance||old.generation!==generation||old.phase==='active') throw new Error('Recovery fence mismatch');return old;});
  }
  async transfer(installation:string,source:string,target:string,generation:string,minimumEpoch=0) {
    let epoch=0;
    await this.change((old,stored)=>{
      if(!old||old.installation!==installation||old.generation!==generation||!(old.instance===source&&old.phase==='held'||old.instance===target&&old.phase==='restored')) throw new Error('Restore overlap or source not held');
      // A retry's minimum is normally met already: the held target database refuses every audit insert before it draws an ID.
      epoch=Math.max(old.phase==='held'?stored+1:stored,minimumEpoch);
      if(!Number.isSafeInteger(epoch)||epoch>=fenceEpochLimit) throw new RecoveryRefusedError(`The transfer needs recovery fence epoch ${epoch}, past the last audit identity epoch, ${fenceEpochLimit-1}, so the fence refused it and is unchanged.${old.phase==='held'?' Authority stays with the held source, which can resume.':''}`);
      return {...old,instance:target,phase:'restored',epoch};
    });
    return epoch;
  }
  async verifyActivation(installation:string,instance:string,generation:string) {
    await this.change(old=>{if(!old||old.installation!==installation||old.instance!==instance||old.generation!==generation) throw new Error('Instance is fenced');return old;});
  }
  async activate(installation:string,instance:string,generation:string) {
    await this.change(old=>{if(!old||old.installation!==installation||old.instance!==instance||old.generation!==generation) throw new Error('Instance is fenced');return {...old,phase:'active'}; // retain generation until the next hold, allowing crash-safe retry
    });
  }
}
