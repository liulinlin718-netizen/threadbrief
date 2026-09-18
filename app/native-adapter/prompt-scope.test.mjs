import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {recordPromptScope,readPromptScope} from './prompt-scope.mjs';

const authority={hostId:'host',accountScope:'account'},child='11111111-1111-4111-8111-111111111111',parent='22222222-2222-4222-8222-222222222222',turn='33333333-3333-4333-8333-333333333333';
const input={hook_event_name:'UserPromptSubmit',agent_id:child,session_id:parent,turn_id:turn};
const notification=()=>({method:'hook/started',params:{threadId:child,turnId:turn,run:{id:'user-prompt-submit:1:C:\\<session-flags>\\config.toml',eventName:'userPromptSubmit',source:'sessionFlags',handlerType:'command',scope:'turn',displayOrder:1,sourcePath:'C:\\<session-flags>\\config.toml'}}});
async function fixture(t){const base=path.resolve(tmpdir()),directory=await mkdtemp(path.join(base,'threadbrief-prompt-scope-'));assert.equal(path.dirname(directory),base);t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}

test('prompt receipts bind official child and turn without using parent session',async t=>{
 const directory=await fixture(t),saved=await recordPromptScope({notification:notification(),directory,authority});
 assert.equal(saved.scope.threadId,child);assert.deepEqual(await readPromptScope({input,directory,authority,waitMs:0}),saved);
 assert.equal(await readPromptScope({input:{...input,agent_id:parent},directory,authority,waitMs:0}),null);
 assert.equal(await readPromptScope({input:{...input,agent_id:undefined},directory,authority,waitMs:0}),null);
 assert.equal(await readPromptScope({input:{...input,turn_id:parent},directory,authority,waitMs:0}),null);
 assert.equal(await readPromptScope({input,directory,authority:{...authority,accountScope:'other'},waitMs:0}),null);
});
test('reject unrelated or malformed event sources',async t=>{
 const directory=await fixture(t);
 for(const patch of [{eventName:'preToolUse'},{source:'user'},{scope:'thread'},{handlerType:'prompt'},{id:'forged'},{displayOrder:-1}]){
  const message=notification();Object.assign(message.params.run,patch);
  assert.equal(await recordPromptScope({notification:message,directory,authority}),null);
 }
 const message=notification();message.params.threadId='../bad';assert.equal(await recordPromptScope({notification:message,directory,authority}),null);
});
test('duplicate receipt does not extend TTL; conflicting identity is rejected',async t=>{
 const directory=await fixture(t),message=notification(),first=await recordPromptScope({notification:message,directory,authority});
 assert.deepEqual(await recordPromptScope({notification:message,directory,authority}),first);
 message.params.threadId=parent;await assert.rejects(recordPromptScope({notification:message,directory,authority}),/Ambiguous/);
 assert.equal(await readPromptScope({input,directory,authority,waitMs:0,now:Date.parse(first.observedAt)+300001}),null);
});
test('receipt corruption and prompt race fail closed or resolve exactly',async t=>{
 const directory=await fixture(t),waiting=readPromptScope({input,directory,authority,waitMs:500});
 await recordPromptScope({notification:notification(),directory,authority});assert.equal((await waiting).scope.threadId,child);
 const file=path.join(directory,(await readdir(directory))[0]),receipt=JSON.parse(await readFile(file,'utf8'));
 await writeFile(file,JSON.stringify({...receipt,source:'user'}));assert.equal(await readPromptScope({input,directory,authority,waitMs:0}),null);
});
