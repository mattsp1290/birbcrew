import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const identity = z.strictObject({ installation: z.uuid(), instance: z.uuid(), generation: z.uuid().nullable(), phase: z.enum(['active','held','restored']) });
export type FenceIdentity = z.infer<typeof identity>;
/** Implement this interface using a linearizable authority shared by both hosts.
 * Never put its state in a recovery bundle or restore it from a snapshot. */
export interface RecoveryFence {
  initialize(installation: string, instance: string): Promise<void>;
  hold(installation: string, instance: string, generation: string): Promise<void>;
  verify(installation: string, instance: string, generation: string): Promise<void>;
  transfer(installation: string, source: string, target: string, generation: string): Promise<void>;
  verifyActivation(installation: string, instance: string, generation: string): Promise<void>;
  activate(installation: string, instance: string, generation: string): Promise<void>;
}
/** Private shared POSIX filesystem authority. Atomic mkdir/rename semantics required.
 * Lock debris after a crash fails closed; an operator must establish no owner is
 * running before removing it. NFS semantics and arbitrary clones are not claimed. */
export class FileRecoveryFence implements RecoveryFence {
  readonly directory: string;
  constructor(directory: string) { this.directory=directory; if (!isAbsolute(directory)) throw new Error('Fence requires an absolute private shared directory'); }
  private async change(run: (old: FenceIdentity | null) => FenceIdentity) {
    await mkdir(this.directory, {recursive:true,mode:0o700});
    const lock=join(this.directory,'lock');
    const syncDirectory=async()=>{const handle=await open(this.directory,'r');try{await handle.sync();}finally{await handle.close();}};
    await mkdir(lock,{mode:0o700});
    await syncDirectory(); // no stale-lock timeout: never steal a live owner
    const temporary=join(this.directory,`.state-${randomUUID()}`);
    try {
      let old: FenceIdentity|null=null;
      try { old=identity.parse(JSON.parse(await readFile(join(this.directory,'state.json'),'utf8'))); }
      catch(e) { if (!(e instanceof Error && 'code' in e && e.code==='ENOENT')) throw e; }
      const next=identity.parse(run(old));
      await writeFile(temporary,JSON.stringify(next),{mode:0o600,flag:'wx',flush:true});
      await rename(temporary,join(this.directory,'state.json'));
      await syncDirectory(); // ownership transfer must be durable before returning
    } finally { await rm(temporary,{force:true}); await rm(lock,{recursive:true}); await syncDirectory(); }
  }
  async initialize(installation:string,instance:string) {
    await this.change(old=>{if(old && (old.installation!==installation||old.instance!==instance)) throw new Error('Fence already belongs to another installation');return old??{installation,instance,generation:null,phase:'active'};});
  }
  async hold(installation:string,instance:string,generation:string) {
    await this.change(old=>{if(!old||old.installation!==installation||old.instance!==instance||(old.phase!=='active'&&old.generation!==generation)) throw new Error('Source is fenced'); return {...old,generation,phase:'held'};});
  }
  async verify(installation:string,instance:string,generation:string) {
    await this.change(old=>{if(!old||old.installation!==installation||old.instance!==instance||old.generation!==generation||old.phase==='active') throw new Error('Recovery fence mismatch');return old;});
  }
  async transfer(installation:string,source:string,target:string,generation:string) {
    await this.change(old=>{if(!old||old.installation!==installation||old.generation!==generation||!(old.instance===source&&old.phase==='held'||old.instance===target&&old.phase==='restored')) throw new Error('Restore overlap or source not held');return {...old,instance:target,phase:'restored'};});
  }
  async verifyActivation(installation:string,instance:string,generation:string) {
    await this.change(old=>{if(!old||old.installation!==installation||old.instance!==instance||old.generation!==generation) throw new Error('Instance is fenced');return old;});
  }
  async activate(installation:string,instance:string,generation:string) {
    await this.change(old=>{if(!old||old.installation!==installation||old.instance!==instance||old.generation!==generation) throw new Error('Instance is fenced');return {...old,phase:'active'}; // retain generation until the next hold, allowing crash-safe retry
    });
  }
}
