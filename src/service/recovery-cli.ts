/** Operator CLI. The selected module is trusted local deployment code, not an
 * AG-UI argument. It owns pools, external fencing, teardown and DB backup tools. */
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {InstallationRecovery,readRecoveryManifest,RecoveryRefusedError,type RecoveryHooks,type RecoveryPins} from './recovery.ts';
export interface RecoveryOperator {
 recovery:InstallationRecovery; pins:RecoveryPins; hooks:RecoveryHooks; close():Promise<void>;
}
const [command,modulePath,...args]=process.argv.slice(2);
let operator:RecoveryOperator|undefined;
try {
 if(!modulePath||!['initialize-fence','hold-for-restore','capture','verify','accept-restore','resume','status'].includes(command)) throw new Error('usage');
 operator=(await import(pathToFileURL(resolve(modulePath)).href)).operator;
 if(!operator||!(operator.recovery instanceof InstallationRecovery)) throw new Error('operator');
 let receipt:unknown;
 switch(command) {
 case 'initialize-fence': await operator.recovery.initializeFence();receipt={status:'initialized'};break;
 case 'hold-for-restore': if(args.length!==1) throw new Error('usage');receipt=await operator.recovery.holdForRestore(args[0],operator.hooks);break;
 case 'capture': if(args.length!==1) throw new Error('usage');receipt=await operator.recovery.capture(resolve(args[0]),operator.pins,operator.hooks);break;
 case 'verify': if(args.length!==1) throw new Error('usage');{const manifest=await readRecoveryManifest(resolve(args[0]));receipt={status:'verified',generation:manifest.generation};}break;
 case 'accept-restore': if(args.length<2||args.length>3) throw new Error('usage');receipt=await operator.recovery.acceptRestore(resolve(args[0]),operator.pins,args[1],args[2]);break;
 case 'resume': if(args.length>1) throw new Error('usage');await operator.recovery.resume(operator.hooks,args[0]?await readRecoveryManifest(resolve(args[0])):null);receipt={status:'active'};break;
 case 'status': {
  const status=await operator.recovery.status();const maxAgeHours=Number(args[0]);
  if(args.length!==1||!Number.isFinite(maxAgeHours)||maxAgeHours<=0) throw new Error('usage');
  const missed=!status.latest||Date.now()-status.latest.completedAt.getTime()>maxAgeHours*3600_000;
  receipt={phase:status.control.phase,lastSuccessfulGeneration:status.latest?.generation??null,lastCompletedAt:status.latest?.completedAt??null,missed};
  if(missed) process.exitCode=2;break;
 }
 }
 console.log(JSON.stringify(receipt));
} catch(error) {
 // Never dump pg connection strings, provider errors, module paths or hook output.
 const message=error instanceof RecoveryRefusedError?error.message:'Recovery operation failed; keep the installation held and inspect private operator diagnostics.';
 console.error(JSON.stringify({status:'failed',message}));process.exitCode=1;
} finally {try{await operator?.close();}catch{process.exitCode=1;}}
