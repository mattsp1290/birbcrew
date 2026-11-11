import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {startRestartFixtures} from './proxy-restart-fixtures.mts';
const run=promisify(execFile);
const directory=await mkdtemp(join(tmpdir(),'birb-recovery-native-'));
const source=join(directory,'host-a');const target=join(directory,'host-b');await mkdir(source);await mkdir(target);
const fixtures=await startRestartFixtures();
try {
 const image='node:22.23.3-bookworm-slim';
 // This is a local synthetic fixture, not permission to run a provider account.
 const launch=async(root:string,mode:string)=>run('docker',['run','--rm','--network','host','--user',`${process.getuid!()}:${process.getgid!()}`,'-v',`${resolve('.') }:/app:ro`,'-v',`${root}:/native`,'-w','/app','-e','HOME=/native','-e','BIRBCREW_PROXY_FIXTURE_ENDPOINTS',image,'node','tests/proof/recovery-native-child.mts',mode],{env:{...process.env,BIRBCREW_PROXY_FIXTURE_ENDPOINTS:JSON.stringify(fixtures.endpoints)},timeout:240_000,maxBuffer:1024*1024});
 await launch(source,'source');
 for(const engine of ['claude','codex','pi'] as const) assert.equal(fixtures.evidence()[engine].requests,1);
 // Source container has exited and been removed; no writer can mutate the archive.
 const archive=join(directory,'native.tar');await run('tar',['-C',source,'-cf',archive,'.']);
 const digest=createHash('sha256').update(await readFile(archive)).digest('hex');
 await run('tar',['-C',target,'-xf',archive]);
 assert.notEqual(source,target);
 assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'),digest);
 for(const engine of ['claude','codex','pi'] as const) assert.equal(await readFile(join(source,'state',engine,'.birbcrew-volume'),'utf8'),await readFile(join(target,'state',engine,'.birbcrew-volume'),'utf8'));
 await launch(target,'restored');
 for(const engine of ['claude','codex','pi'] as const){const e=fixtures.evidence()[engine];assert.equal(e.requests,2);assert.equal(new Set(e.credentialDigests).size,2);}
 console.log('Native archive relocation: three engines followed up from different host roots at the same logical /native mount; identity markers preserved, fresh credentials, no live inference.');
}finally{await fixtures.close();await rm(directory,{recursive:true,force:true});}
