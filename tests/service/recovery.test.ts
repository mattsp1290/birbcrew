import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,test} from 'node:test';
import {Pool} from 'pg';
import {MemberStore} from '../../src/service/store.ts';
import {InstallationRecovery,readRecoveryManifest,type RecoveryPins,type RecoveryHooks} from '../../src/service/recovery.ts';
import {FileRecoveryFence} from '../../src/service/recovery-fence.ts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const url=process.env.BIRBCREW_TEST_DATABASE_URL;
if(!url) throw new Error('Set BIRBCREW_TEST_DATABASE_URL to disposable PostgreSQL17');
const admin=new Pool({connectionString:url});
after(()=>admin.end());
const pins:RecoveryPins={applicationCommit:'a'.repeat(40),lockfileSha256:'b'.repeat(64),temporal:{mode:'development-fixture',serverVersion:'1.10.0',persistenceFormat:'dev-sqlite-fixture'},logicalNativeRoot:'/var/lib/birbcrew/native'};
async function setup() {
 const name='recovery_'+randomUUID().replaceAll('-','');
 await admin.query(`CREATE DATABASE ${name}`);
 const u=new URL(url!);u.pathname='/'+name;
 const pool=new Pool({connectionString:u.toString()});const store=new MemberStore(pool);await store.migrate();
 const directory=await mkdtemp(join(tmpdir(),'birbcrew-recovery-'));
 const fence=new FileRecoveryFence(join(directory,'external-fence'));
 const recovery=new InstallationRecovery(pool,fence);await recovery.initializeFence();
 const bundle=join(directory,'bundle');await import('node:fs/promises').then(fs=>fs.mkdir(bundle));
 const hooks:RecoveryHooks={quiesce:async()=>{},snapshot:async dir=>{const artifacts=[];for(const kind of ['application-postgres','temporal-persistence','native-volumes','configuration'] as const){const file=kind+'.fixture';await writeFile(join(dir,file),'private fixture '+kind);artifacts.push({kind,file});}return artifacts;},reconcile:async()=>{}};
 return {name,pool,store,directory,fence,recovery,bundle,hooks,cleanup:async()=>{await pool.end();await admin.query(`DROP DATABASE ${name} WITH(FORCE)`);await rm(directory,{recursive:true,force:true});}};
}

test('freeze blocks every domain writer including TRUNCATE, survives reconnect, and interrupted capture stays held',async()=>{
 const t=await setup();try {
  const c=await t.store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture'});
  const generation=await t.recovery.freeze();
  await assert.rejects(t.store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture'}),{code:'55000'});
  await assert.rejects(t.pool.query('TRUNCATE birbcrew_ts.public_events'),{code:'55000'});
  assert.equal(await new InstallationRecovery(t.pool,t.fence).freeze(),generation);
  await assert.rejects(t.recovery.capture(t.bundle,pins,{...t.hooks,quiesce:async()=>{throw new Error('native teardown failed');}}),/teardown failed/);
  assert.equal((await t.recovery.status()).control.phase,'frozen');
  assert.equal((await t.recovery.status()).latest,null);
  assert.equal((await t.pool.query('SELECT member_id FROM birbcrew_ts.members')).rows[0].member_id,c.memberId);
  await t.recovery.resume(t.hooks);
  await t.store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture'});
 } finally {await t.cleanup();}
});

test('freeze waits for an already admitted writer before claiming a stable boundary',async()=>{
 const t=await setup();const writer=await t.pool.connect();try {
  await writer.query('BEGIN');await writer.query("INSERT INTO birbcrew_ts.members(owner_id,spawn_request_id,engine,profile) VALUES('owner',$1,'pi','fixture')",[randomUUID()]);
  let completed=false;const frozen=t.recovery.freeze().then(()=>{completed=true;});
  await new Promise(r=>setTimeout(r,75));assert.equal(completed,false);
  await writer.query('COMMIT');await frozen;assert.equal(completed,true);
 } finally {writer.release();await t.cleanup();}
});

test('capture produces checksummed generation and rejects tampering or an unfenced new table',async()=>{
 const t=await setup();try {
  const receipt=await t.recovery.capture(t.bundle,pins,t.hooks);
  const manifest=await readRecoveryManifest(t.bundle);
  assert.equal(manifest.generation,receipt.generation);assert.equal((await t.recovery.status()).latest?.sha256,receipt.sha256);
  assert.equal(JSON.stringify(manifest).includes('private fixture'),false);
  await writeFile(join(t.bundle,manifest.artifacts[0].file),'tampered');
  await assert.rejects(readRecoveryManifest(t.bundle),/mismatch/);
  await t.pool.query('CREATE TABLE birbcrew_ts.unfenced_test(id int)');
  await assert.rejects(t.recovery.capture(t.bundle,pins,t.hooks),/already captured/);
  await t.recovery.resume(t.hooks);
  await assert.rejects(t.recovery.capture(t.bundle,pins,t.hooks),/Unfenced/);
 } finally {await t.cleanup();}
});

test('source cannot resume after authority transfers; arbitrary second clone is rejected',async()=>{
 const t=await setup();try {
  const {generation}=await t.recovery.capture(t.bundle,pins,t.hooks);
  const {control:c}=await t.recovery.status();const target=randomUUID();
  await t.fence.transfer(c.installation,c.instance,target,generation);
  await assert.rejects(t.recovery.resume(t.hooks),/fenced/);
  await assert.rejects(t.fence.transfer(c.installation,c.instance,randomUUID(),generation),/overlap/);
  await assert.rejects(t.fence.hold(c.installation,c.instance,generation),/fenced/);
  assert.equal((await t.recovery.status()).control.phase,'frozen');
 } finally {await t.cleanup();}
});

test('restore rejects version mismatch and leaves matching restore held until explicit reconciliation',async()=>{
 const t=await setup();try {
  await t.recovery.capture(t.bundle,pins,t.hooks);const target=randomUUID();
  await assert.rejects(t.recovery.acceptRestore(t.bundle,{...pins,applicationCommit:'c'.repeat(40)},target),/version/);
  await t.recovery.acceptRestore(t.bundle,pins,target);
  assert.equal((await t.recovery.status()).control.phase,'restored');
  await assert.rejects(t.recovery.resume(t.hooks),/manifest/);
  const manifest=await readRecoveryManifest(t.bundle);
  await assert.rejects(t.recovery.resume({reconcile:async()=>{throw new Error('possible post-RPO effect');}},manifest),/post-RPO/);
  assert.equal((await t.recovery.status()).control.phase,'restored');
  await t.recovery.resume(t.hooks,manifest);
  assert.equal((await t.recovery.status()).control.phase,'active');
 } finally {await t.cleanup();}
});

async function postgresTool(tool:string,args:string[],input?:Buffer) {
 const container=process.env.BIRBCREW_RECOVERY_POSTGRES_CONTAINER;
 const command=container?'docker':join(process.env.BIRBCREW_PG_BIN??'/usr/bin',tool);
 const callArgs=container?['exec','-i',container,tool,...args]:args;
 return new Promise<Buffer>((resolve,reject)=>{
  const child=import('node:child_process').then(({spawn})=>{
   const proc=spawn(command,callArgs,{stdio:['pipe','pipe','pipe']});const chunks:Buffer[]=[];let error='';
   proc.stdout.on('data',chunk=>chunks.push(chunk));proc.stderr.on('data',chunk=>{error+=chunk.toString();});proc.once('error',reject);
   proc.once('close',code=>code===0?resolve(Buffer.concat(chunks)):reject(new Error(`${tool} failed (${code})`)));
   proc.stdin.on('error',()=>{});proc.stdin.end(input);
  });child.catch(reject);
 });
}

test('real PostgreSQL archive restores mappings, checkpoint, committed replay and observation to isolated database; pending remains held',async()=>{
 const t=await setup();const restoredName='recovery_'+randomUUID().replaceAll('-','');let restored:Pool|undefined;
 try {
  const member=await t.store.spawn({ownerId:'owner',requestId:randomUUID(),engine:'pi',profile:'fixture'});
  const key={ownerId:'owner',conversationId:randomUUID()};await t.store.openConversation({...key,memberId:member.memberId});
  const request={...key,requestId:randomUUID(),text:'remember fixture'};
  const turn=await t.store.beginTurn(request);assert.equal(turn.kind,'start');
  await t.store.commitTurn({...key,requestId:request.requestId,token:turn.token,reply:'recorded',checkpoint:{version:1,engine:'pi',state:{fixture:'retained'}}});
  const pending={...key,requestId:randomUUID(),text:'pending fixture'};await t.store.beginTurn(pending);
  const sourceUrl=new URL(url!);sourceUrl.pathname='/'+t.name;
  await t.recovery.capture(t.bundle,pins,{...t.hooks,snapshot:async dir=>{
   const artifacts=await t.hooks.snapshot(dir);
   const dump=await postgresTool('pg_dump',['--dbname',sourceUrl.toString(),'--format=custom','--no-owner']);
   await writeFile(join(dir,'application-postgres.fixture'),dump);return artifacts;
  }});
  const relocated=join(t.directory,'other-host-bundle');await cp(t.bundle,relocated,{recursive:true});
  await admin.query(`CREATE DATABASE ${restoredName}`);
  const restoredUrl=new URL(url!);restoredUrl.pathname='/'+restoredName;
  await postgresTool('pg_restore',['--dbname',restoredUrl.toString(),'--no-owner'],await readFile(join(relocated,'application-postgres.fixture')));
  restored=new Pool({connectionString:restoredUrl.toString()});
  const recovery=new InstallationRecovery(restored,t.fence);const store=new MemberStore(restored);
  await recovery.acceptRestore(relocated,pins,randomUUID());
  assert.deepEqual(await store.getConversation(key),await t.store.getConversation(key));
  assert.deepEqual((await restored.query('SELECT * FROM birbcrew_ts.turns ORDER BY position')).rows,(await t.pool.query('SELECT * FROM birbcrew_ts.turns ORDER BY position')).rows);
  assert.deepEqual(await store.beginTurn(request),{kind:'replay',reply:'recorded'}); // read-only replay remains safe while held
  await assert.rejects(store.beginTurn({...request,requestId:randomUUID()}));
  assert.deepEqual((await restored.query('SELECT * FROM birbcrew_ts.public_events ORDER BY cursor')).rows,(await t.pool.query('SELECT * FROM birbcrew_ts.public_events ORDER BY cursor')).rows);
  assert.ok((await restored.query('SELECT * FROM birbcrew_ts.public_events')).rowCount!>0);
  await assert.rejects(t.recovery.resume(t.hooks),/fenced/);
  const manifest=await readRecoveryManifest(relocated);await recovery.resume(t.hooks,manifest);
  assert.deepEqual(await store.beginTurn(request),{kind:'replay',reply:'recorded'});
  assert.equal((await restored.query('SELECT phase FROM birbcrew_ts.turns WHERE request_id=$1',[pending.requestId])).rows[0].phase,'started');
 } finally {await restored?.end();await admin.query(`DROP DATABASE IF EXISTS ${restoredName} WITH(FORCE)`);await t.cleanup();}
});

test('SIGKILL after external activation before database activation is safely retryable on restored instance',async()=>{
 const t=await setup();try {
  await t.recovery.capture(t.bundle,pins,t.hooks);
  await t.recovery.acceptRestore(t.bundle,pins,randomUUID());
  const u=new URL(url!);u.pathname='/'+t.name;
  await assert.rejects(exec(process.execPath,[new URL('./recovery-crash-child.ts',import.meta.url).pathname,u.toString(),join(t.directory,'external-fence'),t.bundle]),e=>{assert.equal((e as {signal?:string}).signal,'SIGKILL');return true;});
  assert.equal((await t.recovery.status()).control.phase,'restored');
  const fresh=new InstallationRecovery(t.pool,new FileRecoveryFence(join(t.directory,'external-fence')));
  await fresh.resume(t.hooks,await readRecoveryManifest(t.bundle));
  assert.equal((await fresh.status()).control.phase,'active');
 }finally{await t.cleanup();}
});

test('native lifetime barrier waits for surviving lease and held state rejects new native admission',async()=>{
 const {acquireRecoveryNativeLease}=await import('../../src/service/recovery-admission.ts');
 const t=await setup();const native=await t.pool.connect();try {
  await native.query('BEGIN');await acquireRecoveryNativeLease(native);
  let captured=false;
  const capture=t.recovery.capture(t.bundle,pins,t.hooks).then(()=>{captured=true;});
  while((await t.recovery.status()).control.phase!=='frozen') await new Promise(r=>setTimeout(r,10));
  await new Promise(r=>setTimeout(r,50));assert.equal(captured,false);
  await native.query('ROLLBACK');await capture;
  await native.query('BEGIN');await assert.rejects(acquireRecoveryNativeLease(native),/held/);await native.query('ROLLBACK');
 }finally{native.release();await t.cleanup();}
});

test('external preparation before DB freeze cannot authorize restore overlap',async()=>{
 const t=await setup();try {
  const {control:c}=await t.recovery.status();const generation=randomUUID();
  await t.fence.hold(c.installation,c.instance,generation); // controller dies before freezing database
  assert.equal((await t.recovery.status()).control.phase,'active');
  await assert.rejects(t.fence.transfer(c.installation,c.instance,randomUUID(),generation),/overlap/);
  await t.recovery.holdForRestore(generation,t.hooks);
  assert.equal((await t.recovery.status()).control.phase,'frozen');
  await t.fence.transfer(c.installation,c.instance,randomUUID(),generation);
 }finally{await t.cleanup();}
});
