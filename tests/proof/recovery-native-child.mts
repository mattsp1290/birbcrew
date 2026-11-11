// Disposable container child: stable logical /native mount, different host roots.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createProxyProfile} from '../../src/service/proxy-profiles.ts';
import {runClaudeTurn} from '../../src/service/claude.ts';
import {runCodexTurn} from '../../src/service/codex.ts';
import {runPiTurn} from '../../src/service/pi.ts';
import type {Checkpoint} from '../../src/service/domain.ts';
import {z} from 'zod';
const mode=z.enum(['source','restored']).parse(process.argv[2]);
const endpoints=z.object({claude:z.url(),codex:z.url(),pi:z.url()}).parse(JSON.parse(process.env.BIRBCREW_PROXY_FIXTURE_ENDPOINTS??'null'));
// Surface loader/kernel failures before the SDK intentionally redacts its errors.
// This runs the unchanged production Landlock/seccomp launcher, not a bypass.
const probe=spawnSync('/app/.proof/bin/member-launch',[String(process.pid),process.execPath,'-e',"process.stdout.write('native-isolation-ready')"],{
 cwd:'/native',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/native'},encoding:'utf8',timeout:10_000,
});
assert.equal(probe.status,0,`Native isolation prerequisite failed: status=${probe.status}, signal=${probe.signal}, stderr=${probe.stderr}`);
assert.equal(probe.stdout,'native-isolation-ready');
const checkpointFile='/native/checkpoints.json';
const models={claude:'claude-sonnet-4-6',codex:'gpt-5.4',pi:'fixture-chat'} as const;
const protocols={claude:'anthropic-messages',codex:'openai-responses',pi:'openai-chat-completions'} as const;
type Saved={engine:'claude'|'codex'|'pi';threadId:string;memberId:string;nonce:string;checkpoint:Checkpoint};
const saved:Saved[]=mode==='source'?[]:JSON.parse(await readFile(checkpointFile,'utf8'));
for(const engine of ['claude','codex','pi'] as const) {
 const active=await createProxyProfile({engine,protocol:protocols[engine],model:models[engine],endpoint:endpoints[engine],allowHttpLoopback:true,accountId:'fixture-recovery',headers:{'x-fixture-engine':engine},resolveCredential:async()=>{const expiresAt=Date.now()+5000;return{headers:{authorization:`Bearer synthetic-${randomUUID()}-${expiresAt}`},expiresAt};}});
 try {
  const prior=saved.find(x=>x.engine===engine);
  const threadId=prior?.threadId??randomUUID();const memberId=prior?.memberId??randomUUID();const nonce=prior?.nonce??randomUUID();
  const stateDir=join('/native/state',engine);await mkdir(stateDir,{recursive:true,mode:0o700});
  if(mode==='source') await writeFile(join(stateDir,'.birbcrew-volume'),randomUUID(),{flag:'wx',mode:0o600});
  else z.uuid().parse(await readFile(join(stateDir,'.birbcrew-volume'),'utf8'));
  const input={threadId,runId:randomUUID(),text:mode==='source'?'remember '+nonce:'recall',checkpoint:prior?.checkpoint??null,signal:AbortSignal.timeout(60_000)};
  const identity={stateDir,ownerId:'recovery-fixture',memberId};
  const result=engine==='claude'?await runClaudeTurn(input,{...active.profile.claude!,...identity}):engine==='codex'?await runCodexTurn(input,{...active.profile.codex!,...identity}):await runPiTurn(input,active.profile.pi!);
  assert.equal(result.text,(mode==='source'?'stored ':'recalled ')+nonce);
  if(mode==='source') saved.push({engine,threadId,memberId,nonce,checkpoint:result.checkpoint as Checkpoint});
 }finally{await active.close();}
}
if(mode==='source') await writeFile(checkpointFile,JSON.stringify(saved),{flag:'wx',mode:0o600});
console.log(mode==='source'?'Three native sessions created.':'Three engine-native follow-ups passed after archive relocation.');
