// Test-only crash injector; connection points only to disposable fixture DB.
import {Pool} from 'pg';
import {FileRecoveryFence} from '../../src/service/recovery-fence.ts';
import {InstallationRecovery,readRecoveryManifest} from '../../src/service/recovery.ts';
const [url,directory,bundle]=process.argv.slice(2);
class CrashFence extends FileRecoveryFence {
 override async activate(installation:string,instance:string,generation:string) {
  await super.activate(installation,instance,generation);
  process.kill(process.pid,'SIGKILL');
  await new Promise(()=>{});
 }
}
const pool=new Pool({connectionString:url});
await new InstallationRecovery(pool,new CrashFence(directory)).resume({reconcile:async()=>{}},await readRecoveryManifest(bundle));
throw new Error('Crash injection did not execute');
