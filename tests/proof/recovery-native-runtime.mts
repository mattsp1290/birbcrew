/** Native recovery fixture runtime. Uses the production isolation source without
 * bypasses, compiled in the same userspace in which the SDKs will execute. */
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
const run=promisify(execFile);

export async function prepareRecoveryNativeRuntime() {
 const directory=await mkdtemp(join(tmpdir(),'birb-recovery-runtime-'));
 const image='birbcrew-recovery-fixture:'+randomUUID();
 const extraction='birb-recovery-extract-'+randomUUID();
 const containers=new Set<string>();
 let built=false,extractCreated=false;
 async function close() {
  const failures:unknown[]=[];
  for(const name of containers) {
   try{await run('docker',['rm','-f',name],{timeout:30_000});}
   catch(error){if(!String((error as {stderr?:string}).stderr).includes('No such container')) failures.push(error);}
  }
  if(extractCreated)try{await run('docker',['rm','-f',extraction],{timeout:30_000});}catch(error){failures.push(error);}
  if(built)try{await run('docker',['image','rm','-f',image],{timeout:30_000});}catch(error){failures.push(error);}
  await rm(directory,{recursive:true,force:true});
  if(failures.length)throw new AggregateError(failures,'Recovery fixture runtime cleanup failed');
 }
 try {
  await run('docker',['build','--tag',image,'--file',resolve('tests/proof/recovery-native.Dockerfile'),resolve('native')],{timeout:240_000,maxBuffer:4*1024*1024});
  built=true;
  await run('docker',['create','--name',extraction,image],{timeout:30_000});extractCreated=true;
  await run('docker',['cp',extraction+':/opt/birbcrew-native/member-launch',join(directory,'member-launch')],{timeout:30_000});
  await run('docker',['rm',extraction],{timeout:30_000});extractCreated=false;
  // Prove the copied launcher links in its intended runtime. Do not disable
  // Landlock/seccomp if the kernel cannot support the subsequent actual test.
  await run('docker',['run','--rm','-v',`${directory}:/fixture-bin:ro`,image,'sh','-c','ldd /fixture-bin/member-launch && node --version'],{timeout:30_000});
  return {
   image,
   args(root:string,command:string[],environmentKeys:string[]=[]) {
    const name='birb-recovery-native-'+randomUUID();containers.add(name);
    return ['run','--rm','--name',name,'--network','host','--user',`${process.getuid!()}:${process.getgid!()}`,
     '-v',`${resolve('.')}:/app:ro`,'-v',`${resolve(root)}:/native`,'-v',`${directory}:/app/.proof/bin:ro`,
     '-w','/app','-e','HOME=/native',...environmentKeys.flatMap(key=>['-e',key]),image,...command];
   },
   close,
  };
 }catch(error){await close();throw error;}
}
