import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, appendFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ThreadStore } from '../lib/store.mjs';
import { openThreadBindings } from '../lib/thread-bindings.mjs';
import { readNativeEvidence } from '../lib/native-evidence.mjs';

const originalDirectory = fileURLToPath(new URL('.', import.meta.url));
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const authority = { hostId: 'fixture-host', accountScope: 'fixture-account' };
const scope = threadId => ({ ...authority, threadId });

// This CommonJS fixture is the only backend executable input used by the tests.
// It answers RPCs immediately without running a model, network service or UI.
const backendSource = String.raw`
const fs = require('node:fs');
let pending = Buffer.alloc(0);
const native = {name:'codex_app',pluginId:'codex-app-tools@openai-bundled',runtimeStatus:'connected',tools:{open:{name:'open_in_codex',inputSchema:{neverPersist:'schema sentinel'}}}};
const notes = {name:'fixture-notes',pluginId:null,runtimeStatus:'connected',tools:{read:{name:'read_note',inputSchema:{neverPersist:'schema sentinel'}}}};
function answer(frame) {
  let result;
  switch(frame.method) {
    case 'initialize': result={userAgent:'fixture'}; break;
    case 'thread/resume': result={thread:{id:frame.params.threadId,name:frame.params.threadId[0]==='a'?'Fixture A':'Fixture B',cwd:process.env.FIXTURE_TASK_CWD,status:{type:'idle'}}}; break;
    case 'thread/read': result={thread:{id:frame.params.threadId,cwd:process.env.FIXTURE_TASK_CWD,status:{type:'idle'}}}; break;
    case 'turn/start': result={turn:{id:'fixture-turn-'+frame.id,status:'inProgress',items:[],error:null}}; break;
    case 'mcpServerStatus/list': result={data:[native,notes],nextCursor:null}; break;
    case 'mcpServer/tool/call': result={isError:false,content:[{type:'text',text:JSON.stringify({status:'queued',threadId:frame.params.threadId})}]}; break;
    case 'skills/list': result={data:[{cwd:frame.params.cwds[0],skills:[{name:'fixture-skill',path:process.env.FIXTURE_TASK_CWD+'/fixture-skill/SKILL.md',enabled:true}],errors:[]}]}; break;
    case 'config/read': result={config:{...(process.env.FIXTURE_GATEWAY==='true'?{mcp_servers:{'fixture-notes':{command:process.execPath,args:['fixture-entry'],env:{PRESERVED:'yes'}}}}:{}),skills:{config:[{path:process.env.FIXTURE_TASK_CWD+'/sibling/SKILL.md',enabled:false}]}},origins:{},layers:[{name:{type:'user'},version:'fixture-1',config:{skills:{config:[{path:process.env.FIXTURE_TASK_CWD+'/sibling/SKILL.md',enabled:false}]}}}]}; break;
    case 'plugin/installed': result={marketplaces:[{name:'openai-bundled',plugins:[{id:'codex-app-tools@openai-bundled',name:'codex-app-tools',installed:true,enabled:true}]}]}; break;
    case 'app/installed': result={apps:[{id:'app-fixture',name:'Fixture app',enabled:true,callable:true}],nextCursor:null}; break;
    default: throw new Error('Unexpected fixture method: '+frame.method);
  }
  if(frame.id===undefined)return;
  const response=' { "id" : '+JSON.stringify(frame.id)+', "result" : '+JSON.stringify(result)+' } \r\n';
  if(!String(frame.id).startsWith('threadbrief:'))fs.appendFileSync(process.env.FIXTURE_EXPECTED_OUTPUT,response);
  process.stdout.write(response);
}
process.stdin.on('data',chunk=>{
  fs.appendFileSync(process.env.FIXTURE_CAPTURE,chunk);
  pending=Buffer.concat([pending,chunk]);
  let end;
  while((end=pending.indexOf(10))>=0){
    const line=pending.subarray(0,end).toString('utf8').trim();
    pending=pending.subarray(end+1);
    if(line)answer(JSON.parse(line));
  }
});
process.stdin.on('end',()=>process.stdout.write('',()=>process.exit(0)));
`;

async function until(check, description, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  assert.fail(description);
}

async function fixture(t, { gateway = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'threadbrief-automatic-panel-'));
  const nativeDirectory = join(root, 'app', 'native-adapter');
  const libDirectory = join(root, 'app', 'lib');
  await mkdir(nativeDirectory, { recursive: true });
  await mkdir(libDirectory, { recursive: true });
  for (const name of ['proxy.mjs', 'framing.mjs', 'request-overlay.mjs', 'receipt-ledger.mjs', 'internal-rpc.mjs', 'automatic-panel.mjs', 'capability-catalog.mjs', 'capability-overlay.mjs', 'skill-config.mjs', 'skill-turn.mjs', 'mcp-launch-overlay.mjs', 'mcp-policy.mjs', 'app-tool-mapping.mjs']) {
    await copyFile(join(originalDirectory, name), join(nativeDirectory, name));
  }
  for (const name of ['store.mjs', 'host-contract.mjs', 'thread-bindings.mjs', 'native-evidence.mjs']) {
    await copyFile(join(originalDirectory, '..', 'lib', name), join(libDirectory, name));
  }
  const bindingPath = join(root, 'binding.json');
  const panelMetadataFile = join(root, 'panel-metadata.json');
  const registryDirectory = join(root, 'registry');
  const taskCwd = join(root, 'task-workspace');
  await mkdir(taskCwd);
  await writeFile(bindingPath, JSON.stringify(scope(A)));
  await writeFile(panelMetadataFile, JSON.stringify({ ...authority, url: 'http://127.0.0.1:4310/', registryDirectory }));
  const config = {
    nodeExecutable: process.execPath, mcpExecutionGateway: gateway,
    realCodexExecutable: process.execPath,
    realCodexSha256: createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
    currentThreadBinding: bindingPath,
    dataDirectory: join(root, 'data'), evidenceDirectory: join(root, 'bridge-evidence'),
    nativeEvidenceDirectory: join(root, 'task-evidence'), panelMetadataFile,
    automaticPanelMount: true,
  };
  await writeFile(join(nativeDirectory, 'runtime-config.json'), JSON.stringify(config));
  await writeFile(join(root, 'app-server'), backendSource);
  const capture = join(root, 'backend-input.bin');
  const expectedOutput = join(root, 'desktop-output.bin');
  await writeFile(capture, '');
  await writeFile(expectedOutput, '');
  const child = spawn(process.execPath, [join(nativeDirectory, 'proxy.mjs'), 'app-server'], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, THREADBRIEF_LAUNCH_KIND: 'desktop-threadbrief', THREADBRIEF_NATIVE_MOUNT_PROBE: '',
      FIXTURE_CAPTURE: capture, FIXTURE_EXPECTED_OUTPUT: expectedOutput, FIXTURE_TASK_CWD: taskCwd, FIXTURE_GATEWAY: String(gateway) },
  });
  const stdout = [], stderr = [];
  child.stdout.on('data', bytes => stdout.push(bytes));
  child.stderr.on('data', bytes => stderr.push(bytes));
  child.stdin.on('error', () => {});
  const closed = new Promise((fulfill, reject) => {
    child.once('close', (code, signal) => fulfill({ code, signal }));
    child.once('error', reject);
  });
  closed.catch(() => {});
  let finished = false;
  let backendPid;
  const rawFrames = async () => {
    const text = await readFile(capture, 'utf8');
    return text.split(/(?<=\n)/u).filter(line => line.endsWith('\n')).map(raw => ({ raw, value: JSON.parse(raw) }));
  };
  const readEvidence = threadId => readNativeEvidence(config.nativeEvidenceDirectory, scope(threadId), { bridgeDirectory: config.evidenceDirectory });
  async function finish() {
    if (finished) return;
    child.stdin.end();
    const result = await Promise.race([closed, delay(3000).then(() => null)]);
    assert.ok(result, 'Fixture proxy did not stop after EOF');
    assert.equal(result.code, 0, Buffer.concat(stderr).toString('utf8'));
    assert.deepEqual(Buffer.concat(stdout), await readFile(expectedOutput), 'Internal RPC responses leaked or original backend response bytes changed');
    finished = true;
  }
  t.after(async () => {
    // The only kill targets are the owned ChildProcess and the child PID this
    // fixture proxy itself reports inside its exclusive temporary directory.
    child.stdin.end();
    const done = await Promise.race([closed, delay(1500).then(() => null)]);
    if (!done) {
      child.kill();
      if (Number.isSafeInteger(backendPid)) {
        try { process.kill(backendPid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await Promise.race([closed, delay(1500)]);
    }
    const target = resolve(root), temporaryRoot = resolve(tmpdir());
    assert.ok(target.startsWith(`${temporaryRoot}${sep}`) && basename(target).startsWith('threadbrief-automatic-panel-'));
    await rm(target, { recursive: true, force: true });
  });
  const send = async message => {
    const raw = `  ${JSON.stringify(message).replace('"id":', '"id" : ')}  \r\n`;
    child.stdin.write(raw);
    await until(async () => {
      assert.equal(child.exitCode, null, `Fixture bridge exited: ${Buffer.concat(stderr).toString('utf8')}`);
      return (await rawFrames()).some(frame => frame.value.id === message.id);
    }, 'Host request did not reach fixture backend');
    return raw;
  };
  const reject = async message => {
    child.stdin.write(JSON.stringify(message) + '\n');
    const line = await until(() => Buffer.concat(stdout).toString('utf8').split(/(?<=\n)/u)
      .find(raw => { try { return JSON.parse(raw).id === message.id; } catch { return false; } }), 'Expected a task-local error');
    assert.equal(JSON.parse(line).error.code, -32001);
    assert.equal((await rawFrames()).some(frame => frame.value.id === message.id), false, 'Rejected task still reached backend');
    await appendFile(expectedOutput, line);
    return JSON.parse(line);
  };
  await send({ id: 'host-init', method: 'initialize', params: { clientInfo: { name: 'automatic-panel-fixture', version: '1' } } });
  const status = await until(async () => {
    let names;
    try { names = await readdir(config.evidenceDirectory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    for (const name of names.filter(name => /^bridge-\d+\.json$/u.test(name))) {
      const value = JSON.parse(await readFile(join(config.evidenceDirectory, name), 'utf8'));
      if (value.initialized) return value;
    }
    return null;
  }, 'Fixture proxy did not initialize');
  backendPid = status.backendPid;
  assert.equal(status.automaticPanelMount, true);
  assert.equal(status.capabilityEnforcement, false);
  return { root, child, config, taskCwd, registryDirectory, rawFrames, readEvidence, send, reject, finish,
    store: new ThreadStore(config.dataDirectory),
    async mounted(threadId) {
      return until(async () => {
        const value = await readEvidence(threadId);
        return value?.live && value.evidence.mountStatus === 'queued'
          && value.evidence.catalog.some(item => item.kind === 'app') ? value : null;
      }, 'Automatic panel or its complete capability catalog was not observed');
    },
  };
}

test('real proxy automatically queues each task once while preserving host bytes and suppressing internal responses', async t => {
  const f = await fixture(t);
  const originals = new Map();
  for (const [id, threadId] of [[1, A], [2, A], [3, B], [4, A], [5, B]]) {
    originals.set(id, await f.send({ id, method: 'thread/resume', params: { threadId, cwd: f.taskCwd, model: 'fixture-model', config: null } }));
    await f.mounted(threadId);
  }
  const frames = await f.rawFrames();
  for (const [id, raw] of originals) assert.equal(frames.find(frame => frame.value.id === id).raw, raw);
  const opens = frames.filter(frame => frame.value.method === 'mcpServer/tool/call').map(frame => frame.value);
  assert.equal(opens.length, 2);
  assert.deepEqual(new Set(opens.map(frame => frame.params.threadId)), new Set([A, B]));
  const registry = await openThreadBindings({ directory: f.registryDirectory, binding: authority });
  const tokens = [];
  for (const call of opens) {
    assert.equal(call.params.server, 'codex_app');
    assert.equal(call.params.tool, 'open_in_codex');
    assert.deepEqual(call.params._meta, { thread_id: call.params.threadId, threadId: call.params.threadId });
    assert.equal(call.params.arguments.threadId, call.params.threadId);
    assert.equal(call.params.arguments.placement, 'right');
    const url = new URL(call.params.arguments.target.url);
    assert.equal(url.origin, 'http://127.0.0.1:4310');
    const token = url.pathname.slice('/panel/'.length);
    tokens.push(token);
    const record = await registry.lookup(token);
    assert.deepEqual({ hostId: record.hostId, accountScope: record.accountScope, threadId: record.threadId }, scope(call.params.threadId));
    assert.equal(record.title, call.params.threadId === A ? 'Fixture A' : 'Fixture B');
    const evidence = await f.readEvidence(call.params.threadId);
    assert.equal(evidence.evidence.mountStatus, 'queued');
    assert.deepEqual(new Set(evidence.evidence.catalog.map(item => item.kind)), new Set(['mcp', 'skill', 'plugin', 'app']));
    assert.equal(evidence.evidence.capabilityStatus, 'catalog-observed');
    assert.doesNotMatch(JSON.stringify(evidence), /schema sentinel|neverPersist/);
  }
  assert.notEqual(tokens[0], tokens[1]);
  assert.ok(frames.filter(frame => String(frame.value.id).startsWith('threadbrief:')).every(frame => ['mcpServerStatus/list', 'mcpServer/tool/call', 'skills/list', 'plugin/installed', 'app/installed'].includes(frame.value.method)));
  assert.equal(frames.some(frame => ['turn/start', 'thread/inject_items', 'thread/unsubscribe', 'config/batchWrite'].includes(frame.value.method)), false);
  const queriedCwds = frames.filter(frame => ['skills/list', 'plugin/installed'].includes(frame.value.method));
  // Repeated natural resumes may refresh capability metadata without reopening
  // the already queued panel; only the query scope, not its count, is fixed.
  assert.ok(queriedCwds.length >= 4);
  assert.ok(queriedCwds.every(frame => frame.value.params.cwds[0] === f.taskCwd));
  assert.ok(frames.filter(frame => frame.value.method === 'skills/list').every(frame => frame.value.params.forceReload === true));
  assert.ok(frames.filter(frame => frame.value.method === 'app/installed').every(frame => frame.value.params.forceRefresh === true));
  assert.ok(frames.filter(frame => ['mcpServerStatus/list', 'app/installed'].includes(frame.value.method))
    .every(frame => [A, B].includes(frame.value.params.threadId)));
  for (const threadId of [A, B]) assert.deepEqual(await f.store.get(scope(threadId)), { revision: 0, persona: '', background: '', overrides: {} });
  await f.finish();
});

test('a saved task capability changes only its natural resume config and never claims runtime enforcement', async t => {
  const f = await fixture(t);
  for (const [id, threadId] of [[1, A], [2, B]]) {
    await f.send({ id, method: 'thread/resume', params: { threadId, cwd: f.taskCwd } });
    await f.mounted(threadId);
  }
  const catalog = (await f.readEvidence(A)).evidence.catalog;
  const notes = catalog.find(item => item.kind === 'mcp' && item.name === 'fixture-notes');
  assert.deepEqual(notes.configMapping, { kind: 'mcp-server', serverName: 'fixture-notes' });
  await f.store.save(scope(A), { expectedRevision: 0, persona: '', background: '', overrides: { [notes.id]: 'off' } });
  const hostConfig = {
    mcp_servers: { 'fixture-notes': { enabled: true, command: 'fixture-only-command', env: { FIXTURE: 'preserve' }, tools: { read_note: { enabled: true } } } },
    model_reasoning_effort: 'high', unrelated_host_setting: { keep: true },
  };
  const parameters = {
    threadId: A, cwd: f.taskCwd, model: 'fixture-model', modelProvider: 'fixture-provider',
    approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write',
    baseInstructions: 'Existing host base instructions', developerInstructions: 'Existing host developer instructions',
    history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Existing fixture input stays exact' }] }],
    reasoning: { effort: 'high' }, permissionProfile: 'fixture-profile', serviceTier: null,
    config: hostConfig,
  };
  await f.send({ id: 10, method: 'thread/resume', params: parameters });
  const received = (await f.rawFrames()).find(frame => frame.value.id === 10).value;
  const expected = structuredClone({ id: 10, method: 'thread/resume', params: parameters });
  expected.params.config.mcp_servers['fixture-notes'].enabled = false;
  assert.deepEqual(received, expected, 'The overlay changed existing host instructions, input, model, permissions or unrelated config');
  const rawB = await f.send({ id: 11, method: 'thread/resume', params: { ...parameters, threadId: B } });
  assert.equal((await f.rawFrames()).find(frame => frame.value.id === 11).raw, rawB, 'Task A preference affected task B bytes');
  const pending = await until(async () => {
    const value = await f.readEvidence(A);
    return value?.evidence.capabilityStatus === 'pending-reload' ? value : null;
  }, 'Prepared capability delta was not recorded');
  assert.equal(pending.evidence.capabilityRevision, 1);
  assert.equal(pending.bridge.capabilityEnforcement, false);
  assert.equal((await f.readEvidence(B)).evidence.capabilityStatus, 'catalog-observed');
  assert.deepEqual(await f.store.get(scope(B)), { revision: 0, persona: '', background: '', overrides: {} });
  const frames = await f.rawFrames();
  assert.equal(frames.filter(frame => frame.value.method === 'mcpServer/tool/call').length, 2, 'Later resumes opened duplicate panels');
  assert.equal(frames.some(frame => ['turn/start', 'thread/inject_items', 'thread/unsubscribe', 'config/batchWrite'].includes(frame.value.method)), false);
  await f.finish();
});

test('skill switches leave the native loader unchanged so on can work after off', async t => {
  const f = await fixture(t);
  for (const [id, threadId] of [[1, A], [2, B]]) {
    await f.send({ id, method: 'thread/resume', params: { threadId, cwd: f.taskCwd } });
    await f.mounted(threadId);
  }
  const skill = (await f.readEvidence(A)).evidence.catalog.find(item => item.kind === 'skill');
  assert.equal(skill.configMapping.skillName, 'fixture-skill');
  await f.store.save(scope(A), { expectedRevision: 0, persona: '', background: '', overrides: { [skill.id]: 'off' } });
  const message = { id: 10, method: 'thread/resume', params: { threadId: A, cwd: f.taskCwd,
    baseInstructions: 'Existing base', developerInstructions: 'Existing developer',
    approvalPolicy: 'on-request', sandbox: 'read-only', model: 'fixture-model',
    config: { skills: { max_context_tokens: 3000 }, model_reasoning_effort: 'high' } } };
  await f.send(message);
  const frames = await f.rawFrames();
  assert.deepEqual(frames.find(frame => frame.value.id === 10).value, message);
  const reads = frames.filter(frame => frame.value.method === 'config/read');
  assert.equal(reads.length, 0);
  const rawB = await f.send({ ...message, id: 11, params: { ...message.params, threadId: B } });
  assert.equal((await f.rawFrames()).find(frame => frame.value.id === 11).raw, rawB);
  await f.store.save(scope(A), { expectedRevision: 1, persona: '', background: '', overrides: {} });
  const rawReset = await f.send({ ...message, id: 12 });
  const after = await f.rawFrames();
  assert.equal(after.find(frame => frame.value.id === 12).raw, rawReset);
  assert.equal(after.filter(frame => frame.value.method === 'config/read').length, 0);
  assert.equal(after.some(frame => ['turn/start', 'thread/unsubscribe', 'skills/config/write', 'config/batchWrite'].includes(frame.value.method)), false);
  await f.finish();
});

test('the actual proxy adds a selected skill only to its task and stops adding it after off', async t => {
  const f = await fixture(t);
  for (const [id, threadId] of [[1, A], [2, B]]) {
    await f.send({ id, method: 'thread/resume', params: { threadId, cwd: f.taskCwd } });
    await f.mounted(threadId);
  }
  const skill = (await f.readEvidence(A)).evidence.catalog.find(item => item.kind === 'skill');
  await f.store.save(scope(A), { expectedRevision: 0, persona: 'Fixture persona', background: '', overrides: { [skill.id]: 'on' } });
  const turn = (id, threadId = A) => ({ id, method: 'turn/start', params: { threadId,
    input: [{ type: 'text', text: 'Fixture input' }], model: 'fixture-model',
    sandboxPolicy: { type: 'readOnly' }, collaborationMode: { mode: 'plan', settings: { model: 'fixture-model', reasoning_effort: 'high', developer_instructions: 'Keep mode' } },
  } });
  await f.send(turn(10));
  const sent = (await f.rawFrames()).find(frame => frame.value.id === 10).value;
  assert.deepEqual(sent.params.input, [...turn(10).params.input, { type: 'skill', name: skill.configMapping.skillName, path: skill.configMapping.path }]);
  assert.deepEqual(sent.params.collaborationMode, turn(10).params.collaborationMode);
  assert.deepEqual(sent.params.sandboxPolicy, turn(10).params.sandboxPolicy);
  assert.match(sent.params.additionalContext.threadbrief.value, /Fixture persona/u);
  await until(async () => (await f.readEvidence(A))?.evidence.skillInputRevision === 1, 'Skill input acceptance was not recorded');
  const rawB = await f.send(turn(11, B));
  assert.equal((await f.rawFrames()).find(frame => frame.value.id === 11).raw, rawB);
  await f.store.save(scope(A), { expectedRevision: 1, persona: 'Fixture persona', background: '', overrides: { [skill.id]: 'off' } });
  await f.send(turn(12));
  const after = (await f.rawFrames()).find(frame => frame.value.id === 12).value;
  assert.deepEqual(after.params.input, turn(12).params.input);
  assert.equal(after.params.additionalContext.threadbrief.value, sent.params.additionalContext.threadbrief.value, 'A capability change rewrote stable persona context');
  assert.equal((await f.rawFrames()).some(frame => ['thread/unsubscribe', 'skills/config/write'].includes(frame.value.method)), false);
  await f.finish();
});

test('a task profile error rejects only its request and leaves other tasks running', async t => {
  const f = await fixture(t);
  await f.store.save(scope(A), { expectedRevision: 0, persona: 'Fixture', background: '', overrides: {} });
  const rejected = await f.reject({ id: 30, method: 'turn/start', params: { threadId: A, input: [], additionalContext: { threadbrief: { kind: 'untrusted', value: 'Owned by another producer' } } } });
  assert.equal(rejected.error.data.code, 'CONTEXT_SOURCE_CONFLICT');
  const turn = { id: 31, method: 'turn/start', params: { threadId: B, input: [{ type: 'text', text: 'Unaffected task' }] } };
  const raw = await f.send(turn);
  assert.equal((await f.rawFrames()).find(frame => frame.value.id === 31).raw, raw);
  await f.send({ id: 32, method: 'turn/start', params: { threadId: A, input: [{ type: 'text', text: 'Retry after fixing the input' }] } });
  assert.equal(f.child.exitCode, null);
  await f.finish();
});

test('production lifecycle installs the MCP execution gate without disabling the native server', async t => {
  const f = await fixture(t, { gateway: true });
  const original = { id: 1, method: 'thread/resume', params: { threadId: A, cwd: f.taskCwd,
    model: 'fixture-model', approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: 'Host instructions',
  } };
  await f.send(original);
  await f.mounted(A);
  const received = (await f.rawFrames()).find(frame => frame.value.id === 1).value;
  const server = received.params.config.mcp_servers['fixture-notes'];
  assert.equal(server.command, process.execPath);
  assert.equal(server.args[0], join(f.root, 'app', 'native-adapter', 'mcp-gateway.mjs'));
  assert.deepEqual(server.args.slice(2), ['fixture-notes', '', '--', process.execPath, 'fixture-entry']);
  assert.deepEqual({ ...received, params: { ...received.params, config: undefined } }, { ...original, params: { ...original.params, config: undefined } });
  const notes = (await f.readEvidence(A)).evidence.catalog.find(item => item.name === 'fixture-notes');
  await f.store.save(scope(A), { expectedRevision: 0, persona: '', background: '', overrides: { [notes.id]: 'off' } });
  await f.send({ ...original, id: 2 });
  const next = (await f.rawFrames()).find(frame => frame.value.id === 2).value;
  assert.deepEqual(next.params.config, received.params.config, 'A switch must change gateway policy, not disable and strand its process');
  assert.equal((await f.rawFrames()).some(frame => ['thread/unsubscribe', 'config/batchWrite'].includes(frame.value.method)), false);
  await f.finish();
});
