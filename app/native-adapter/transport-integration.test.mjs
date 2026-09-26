import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { ThreadStore } from '../lib/store.mjs';
import { readAcceptedReceipt } from './receipt-ledger.mjs';

const originalDirectory = fileURLToPath(new URL('.', import.meta.url));
const scope = { hostId: 'fixture-host', accountScope: 'fixture-account', threadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const nodeFingerprint = readFile(process.execPath).then(bytes => createHash('sha256').update(bytes).digest('hex'));
const profile = (expectedRevision, persona = '', background = '', overrides = {}) => ({ expectedRevision, persona, background, overrides });
const request = () => ({ id: 17, method: 'turn/start', params: { threadId: scope.threadId, input: [{ type: 'text', text: 'synthetic transport fixture' }], additionalContext: { host: { kind: 'application', value: 'untouched host fragment' } } } });
const backendSource = String.raw`
const fs = require('node:fs');
const phase = name => fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({phase:name,pid:process.pid,at:Date.now()})+'\n');
phase('backend-ready');
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  phase('backend-input-complete');
  const bytes = Buffer.concat(chunks);
  fs.writeFileSync(process.env.FIXTURE_CAPTURE, bytes);
  const frames = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const output = frames.map(frame => {
    if (frame.method === 'turn/start') return ' { "id" : ' + JSON.stringify(frame.id) + ', "result" : { "turn" : { "id" : "fixture-turn", "status" : "inProgress", "items" : [], "error" : null } } } \r\n';
    return JSON.stringify({id:frame.id,result:{fixture:true}})+'\n';
  }).join('');
  const tail = JSON.stringify({method:'fixture/argv',params:{args:process.argv.slice(2)}})+'\n';
  const large = process.env.FIXTURE_LARGE_OUTPUT ? JSON.stringify({method:'fixture/large',params:{text:'x'.repeat(180000)}})+'\n' : '';
  const result = Buffer.from(output+tail+large);
  fs.writeFileSync(process.env.FIXTURE_EXPECTED_OUTPUT,result);
  process.stdout.write(result, () => {phase('backend-output-flushed');process.exit(0);});
});
`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'threadbrief-transport-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const nativeDirectory = join(root, 'app', 'native-adapter');
  const libDirectory = join(root, 'app', 'lib');
  await mkdir(nativeDirectory, { recursive: true });
  await mkdir(libDirectory, { recursive: true });
  for (const name of ['proxy.mjs', 'task-scheduler.mjs', 'background-work.mjs', 'framing.mjs', 'request-overlay.mjs', 'receipt-ledger.mjs']) await copyFile(join(originalDirectory, name), join(nativeDirectory, name));
  for (const name of ['diagnostic-json.mjs', 'store.mjs', 'host-contract.mjs']) await copyFile(join(originalDirectory, '..', 'lib', name), join(libDirectory, name));
  let shim;
  if (process.platform === 'win32') {
    try {
      shim = join(nativeDirectory, 'threadbrief-codex.exe');
      await copyFile(join(originalDirectory, 'threadbrief-codex.exe'), shim);
    } catch (error) { if (error.code !== 'ENOENT') throw error; shim = undefined; }
  }
  const bindingPath = join(root, 'binding.json');
  await writeFile(bindingPath, JSON.stringify(scope));
  const config = {
    nodeExecutable: process.execPath,
    realCodexExecutable: process.execPath,
    realCodexSha256: await nodeFingerprint,
    currentThreadBinding: bindingPath,
    dataDirectory: join(root, 'data'),
    evidenceDirectory: join(root, 'evidence'),
  };
  const configPath = join(nativeDirectory, 'runtime-config.json');
  await writeFile(configPath, JSON.stringify(config));
  // Node itself acts as the fake CLI executable: its first unchanged argument,
  // app-server, resolves to this isolated CommonJS script in the temporary cwd.
  await writeFile(join(root, 'app-server'), backendSource);
  return {
    root, nativeDirectory, config, configPath, shim,
    store: new ThreadStore(config.dataDirectory),
    env: { ...process.env, FIXTURE_CAPTURE: join(root, 'capture.bin'), FIXTURE_EXPECTED_OUTPUT: join(root, 'expected-output.bin'), FIXTURE_TRACE: join(root, 'phases.ndjson') },
  };
}

async function run(f, bytes, { args = ['app-server'], executable = 'node', environment = {}, keepInputOpen = false, timeoutMs = 5000 } = {}) {
  const command = executable === 'shim' ? f.shim : process.execPath;
  assert.ok(command, 'The compiled bridge is required for this case');
  const argv = executable === 'shim' ? args : [join(f.nativeDirectory, 'proxy.mjs'), ...args];
  const trace = join(f.root, `phases-${randomUUID()}.ndjson`);
  const started = Date.now();
  const phases = [{ phase: 'spawn-requested', ms: 0 }];
  const mark = phase => phases.push({ phase, ms: Date.now() - started });
  const child = spawn(command, argv, { cwd: f.root, env: { ...f.env, ...environment, FIXTURE_TRACE: trace }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.once('spawn', () => mark('process-spawned'));
  child.once('exit', () => mark('process-exited'));
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => { if (!stdout.length) mark('first-output'); stdout.push(chunk); });
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.stdin.on('error', () => {});
  if (keepInputOpen) child.stdin.write(bytes);
  else child.stdin.end(bytes);
  const readPhases = async () => {
    try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(async () => {
      timedOut = true;
      try {
        const backend = await readPhases();
        child.kill();
        // A raw Node proxy has no enclosing Windows Job Object. Its fake backend
        // can still be waiting for the test's release file after the proxy dies.
        for (const pid of new Set(backend.map(item => item.pid))) {
          try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        await Promise.race([closed, delay(1000)]);
        reject(new Error(`Fixture bridge did not exit within ${timeoutMs / 1000} seconds; phases=${JSON.stringify([...phases, ...backend.map(({phase,at}) => ({phase,ms:at-started}))].sort((a,b)=>a.ms-b.ms))}; stderr=${Buffer.concat(stderr).toString('utf8')}`));
      } catch (error) {
        child.kill();
        reject(error);
      }
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', async (code, signal) => {
      clearTimeout(timer);
      mark('pipes-closed');
      if (timedOut) return;
      try {
        const timeline = [...phases, ...(await readPhases()).map(({phase,at}) => ({phase,ms:at-started}))].sort((a,b)=>a.ms-b.ms);
        if (process.env.THREADBRIEF_TEST_TIMING) process.stdout.write(`# transport ${executable}: ${JSON.stringify(timeline)}\n`);
        resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8'), phases: timeline });
      } catch (error) { reject(error); }
    });
  });
}

test('real proxy process forwards untouched RPC bytes and drains a large final backend output', async t => {
  const f = await fixture(t);
  const raw = Buffer.from('  ' + JSON.stringify(request(), null, 0).replace('"id":17', '"id" : 17') + '  \r\n');
  const result = await run(f, raw, { environment: { FIXTURE_LARGE_OUTPUT: '1' } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await readFile(f.env.FIXTURE_CAPTURE), raw);
  assert.deepEqual(result.stdout, await readFile(f.env.FIXTURE_EXPECTED_OUTPUT));
  assert.deepEqual(await f.store.get(scope), { revision: 0, persona: '', background: '', overrides: {} });
  assert.deepEqual(await f.store.observations(scope), []);
  const evidence = await readdir(f.config.evidenceDirectory);
  assert.equal(evidence.includes('receipts'), false);
});

test('an unwritable diagnostic and receipt directory preserves accepted responses and unrelated tasks', async t => {
  const f = await fixture(t);
  // A regular file where a directory is required is a deterministic I/O error
  // on Windows too, without changing the user's permissions or real storage.
  await writeFile(f.config.evidenceDirectory, 'fixture-not-a-directory');
  await f.store.save(scope, profile(0, 'Fixture profile'));
  const other = { ...request(), id: 18, params: { ...request().params, threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } };
  const result = await run(f, Buffer.from([request(), other].map(value => JSON.stringify(value) + '\n').join('')));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.stdout, await readFile(f.env.FIXTURE_EXPECTED_OUTPUT));
  const captured = (await readFile(f.env.FIXTURE_CAPTURE, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(captured.length, 2);
  assert.equal(captured.find(x => x.id === 18).params.additionalContext.threadbrief, undefined);
});

test('compiled shim preserves CLI argument quoting and persona context survives through accepted receipt storage', async t => {
  const f = await fixture(t);
  if (!f.shim) { t.skip('Compiled Windows shim is unavailable'); return; }
  await f.store.save(scope, profile(0, 'Transport fixture reviewer', 'Fixture only'));
  const special = ['--fixture-flag', 'C:\\path with spaces\\', 'quote "inside"', '中文', '', 'tail\\'];
  const result = await run(f, Buffer.from(JSON.stringify(request()) + '\n'), { executable: 'shim', args: ['app-server', ...special] });
  assert.equal(result.code, 0, result.stderr);
  const captured = JSON.parse((await readFile(f.env.FIXTURE_CAPTURE, 'utf8')).trim());
  assert.deepEqual(captured.params.input, request().params.input);
  assert.deepEqual(captured.params.additionalContext.host, request().params.additionalContext.host);
  assert.equal(captured.params.additionalContext.threadbrief.kind, 'untrusted');
  assert.match(captured.params.additionalContext.threadbrief.value, /Transport fixture reviewer/u);
  assert.deepEqual(result.stdout, await readFile(f.env.FIXTURE_EXPECTED_OUTPUT));
  const argv = result.stdout.toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).find(frame => frame.method === 'fixture/argv');
  assert.deepEqual(argv.params.args, special);
  const receipt = await readAcceptedReceipt(join(f.config.evidenceDirectory, 'receipts'), scope);
  assert.ok(receipt);
  assert.equal(receipt.status, 'app-server-accepted');
  assert.deepEqual(receipt.scope, scope);
  const observations = await f.store.observations(scope);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].status, 'accepted');
  const audits = (await readdir(f.config.evidenceDirectory)).filter(name => name.endsWith('.ndjson'));
  const auditText = (await Promise.all(audits.map(name => readFile(join(f.config.evidenceDirectory, name), 'utf8')))).join('');
  assert.doesNotMatch(auditText, /Transport fixture reviewer|Fixture only|Original request|synthetic transport fixture/u);
});

test('complete final JSON without newline cannot bypass persona preparation', async t => {
  const f = await fixture(t);
  await f.store.save(scope, profile(0, 'EOF fixture reviewer'));
  const result = await run(f, Buffer.from(JSON.stringify(request())));
  assert.equal(result.code, 0, result.stderr);
  const raw = await readFile(f.env.FIXTURE_CAPTURE, 'utf8');
  const captured = JSON.parse(raw);
  assert.equal(raw.endsWith('\n'), false);
  assert.equal(captured.params.additionalContext.threadbrief?.kind, 'untrusted');
});

test('backend launch failure exits even while the upstream stdin is left open', async t => {
  const f = await fixture(t);
  f.config.realCodexExecutable = join(f.root, 'does-not-exist.exe');
  await writeFile(f.configPath, JSON.stringify(f.config));
  const result = await run(f, Buffer.alloc(0), { args: ['--version'], keepInputOpen: true });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /backend launch failed|bridge stopped|ENOENT/u);
});

test('a timed-out fixture reports its completed phases and stops its own waiting backend', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'app-server'), String.raw`
const fs=require('node:fs');
fs.writeFileSync(process.env.FIXTURE_CAPTURE,JSON.stringify({pid:process.pid}));
fs.appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify({phase:'backend-ready',pid:process.pid,at:Date.now()})+'\n');
setInterval(()=>{},1000);
`);
  await assert.rejects(run(f, Buffer.alloc(0)), /within 5 seconds; phases=.*backend-ready/u);
  const { pid } = JSON.parse(await readFile(f.env.FIXTURE_CAPTURE, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'A fixture backend survived timeout cleanup');
});

test('compiled shim flushes interactive replies without stdin EOF and its job stops fixture descendants', async t => {
  const f = await fixture(t);
  if (!f.shim) { t.skip('Compiled Windows shim is unavailable'); return; }
  await writeFile(join(f.root, 'app-server'), String.raw`
const fs=require('node:fs');
const readline=require('node:readline');
const phase=name=>fs.appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify({phase:name,pid:process.pid,at:Date.now()})+'\n');
phase('backend-ready');
const lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{
  fs.appendFileSync(process.env.FIXTURE_CAPTURE,line+'\n');
  const request=JSON.parse(line);
  phase('backend-request-'+request.id);
  const result=request.method==='initialize'?{userAgent:'fixture'}:{turn:{id:'interactive-fixture-turn',status:'inProgress',items:[],error:null}};
  process.stdout.write(JSON.stringify({id:request.id,result})+'\n');
});
lines.on('close',()=>process.stdout.write('',()=>process.exit(0)));
`);
  const started = Date.now();
  const child = spawn(f.shim, ['app-server'], { cwd: f.root, env: f.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.stdin.on('error', () => {});
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const lines = createInterface({ input: child.stdout });
  const received = new Map();
  const replies = [];
  lines.on('line', line => { const frame = JSON.parse(line); received.set(frame.id, frame); replies.push({ phase: `reply-${frame.id}`, ms: Date.now() - started }); });
  const failureDetail = async () => {
    const trace = await readFile(f.env.FIXTURE_TRACE, 'utf8').catch(error => error.code === 'ENOENT' ? 'backend did not reach ready' : Promise.reject(error));
    return `phases=${trace.trim()}; replies=${JSON.stringify(replies)}; stderr=${Buffer.concat(stderr).toString('utf8')}`;
  };
  let backendPid;
  let proxyPid;
  try {
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } }) + '\n');
    for (let i = 0; i < 100 && !received.has(1); i += 1) await delay(30);
    if (!received.has(1)) assert.fail(`Interactive initialize reply did not arrive without EOF: ${await failureDetail()}`);
    child.stdin.write(JSON.stringify(request()) + '\n');
    for (let i = 0; i < 100 && !received.has(17); i += 1) await delay(30);
    if (!received.has(17)) assert.fail(`Interactive turn response did not arrive while stdin stayed open: ${await failureDetail()}`);
    const names = (await readdir(f.config.evidenceDirectory)).filter(name => /^bridge-\d+\.json$/u.test(name));
    assert.equal(names.length, 1);
    const status = JSON.parse(await readFile(join(f.config.evidenceDirectory, names[0]), 'utf8'));
    backendPid = status.backendPid;
    proxyPid = status.pid;
    assert.equal(Number.isSafeInteger(backendPid), true);
    assert.doesNotThrow(() => process.kill(backendPid, 0));
    child.kill();
    const closeResult = await Promise.race([closed, delay(3000).then(() => null)]);
    assert.ok(closeResult, 'Terminated fixture shim did not close its pipes');
    const alive = pid => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    for (let i = 0; i < 60 && (alive(backendPid) || alive(proxyPid)); i += 1) await delay(30);
    assert.equal(alive(backendPid), false, 'Fake backend outlived its terminated shim job');
    assert.equal(alive(proxyPid), false, 'Node proxy outlived its terminated shim job');
    if (process.env.THREADBRIEF_TEST_TIMING) {
      const timeline = (await readFile(f.env.FIXTURE_TRACE, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).map(({phase,at}) => ({phase,ms:at-started}));
      t.diagnostic(`interactive: ${JSON.stringify([...timeline,...replies].sort((a,b)=>a.ms-b.ms))}`);
    }
  } finally {
    child.kill();
    lines.close();
    // These pids come only from this fixture's own status file. Clean up after a
    // failed lifecycle assertion so the test never leaves fake helpers behind.
    for (const pid of [backendPid, proxyPid]) {
      if (!Number.isSafeInteger(pid)) continue;
      try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await Promise.race([closed, delay(1000)]);
  }
});

test('late acceptance from an older bridge cannot replace a newer configuration receipt', async t => {
  const f = await fixture(t);
  await f.store.save(scope, profile(0, 'Older profile'));
  await writeFile(join(f.root, 'app-server'), String.raw`
const fs=require('node:fs');
const phase=name=>fs.appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify({phase:name,pid:process.pid,at:Date.now()})+'\n');
phase('backend-ready');
const chunks=[];
process.stdin.on('data',chunk=>chunks.push(chunk));
process.stdin.on('end',()=>{
  phase('backend-input-complete');
  const bytes=Buffer.concat(chunks);fs.writeFileSync(process.env.FIXTURE_CAPTURE,bytes);
  const frame=JSON.parse(bytes.toString('utf8').trim());
  const send=()=>process.stdout.write(JSON.stringify({id:frame.id,result:{turn:{id:'fixture-delayed-turn',status:'inProgress',items:[],error:null}}})+'\n',()=>{phase('backend-output-flushed');process.exit(0);});
  if(!process.env.FIXTURE_RELEASE){send();return;}
  // This response deliberately waits for another bridge, whose own bounded
  // run can take five seconds, plus the intervening profile/receipt writes.
  const deadline=Date.now()+10000;
  const timer=setInterval(()=>{if(fs.existsSync(process.env.FIXTURE_RELEASE)){clearInterval(timer);send();}else if(Date.now()>deadline){clearInterval(timer);process.exit(5);}},10);
});
`);
  const release = join(f.root, 'release-older');
  const oldCapture = join(f.root, 'old-capture.bin');
  // Only this deliberately blocked older bridge gets a larger outer budget:
  // startup/capture, the newer bridge's normal 5s run, release and output drain.
  // Its backend still independently fails after a bounded 10s release wait.
  const old = run(f, Buffer.from(JSON.stringify(request()) + '\n'), { timeoutMs: 15000,
    environment: { FIXTURE_RELEASE: release, FIXTURE_CAPTURE: oldCapture } });
  old.catch(() => {});
  try {
    let captured;
    for (let i = 0; i < 100 && !captured; i += 1) {
      try { captured = JSON.parse(await readFile(oldCapture, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await delay(20); }
    }
    assert.ok(captured, 'The older request did not reach its fake backend');
    assert.match(captured.params.additionalContext.threadbrief.value, /Older profile/u);
    await f.store.save(scope, profile(1, 'Newer profile'));
    const newer = await run(f, Buffer.from(JSON.stringify({ ...request(), id: 18 }) + '\n'));
    assert.equal(newer.code, 0, newer.stderr);
    await writeFile(release, 'release');
    const older = await old;
    assert.equal(older.code, 0, older.stderr);
    const receiptDirectory = join(f.config.evidenceDirectory, 'receipts');
    const receipt = await readAcceptedReceipt(receiptDirectory, scope);
    assert.equal(receipt?.revision, 2, 'A late older result overwrote the only proof of the newer accepted overlay');
  } finally {
    await writeFile(release, 'release');
    await old;
  }
});
