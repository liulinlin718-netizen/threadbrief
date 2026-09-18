import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readAcceptedReceipt, writeAcceptedReceipt } from './receipt-ledger.mjs';

const run = promisify(execFile);
const moduleURL = new URL('./receipt-ledger.mjs', import.meta.url).href;
const scope = { hostId: 'local', accountScope: 'account-A', threadId: 'thread-A' };
const receipt = (revision, mode = 'overlay', compiledHash = String(revision).padStart(64, '0'), scoped = scope) => ({
  type: 'threadbrief.app-server-accepted', version: 1, status: 'app-server-accepted', evidence: 'turn/start.result',
  scope: scoped, revision, compiledHash, mode, requestId: revision, turnId: `turn-${revision}`,
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'threadbrief-receipts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: join(root, 'receipts') };
}

test('reading no receipt creates no files and late old reset cannot replace newer overlay', async t => {
  const { root, directory } = await fixture(t);
  assert.equal(await readAcceptedReceipt(directory, scope), null);
  assert.deepEqual(await readdir(root), []);
  await writeAcceptedReceipt(directory, receipt(3));
  await writeAcceptedReceipt(directory, receipt(2, 'reset'));
  assert.equal((await readAcceptedReceipt(directory, scope)).revision, 3);
  assert.equal((await readAcceptedReceipt(directory, scope)).mode, 'overlay');
});

test('every scope field isolates receipt history and path-like thread ids stay hashed', async t => {
  const { directory } = await fixture(t);
  await writeAcceptedReceipt(directory, receipt(1));
  for (const other of [{ ...scope, hostId: 'remote' }, { ...scope, accountScope: 'other' }, { ...scope, threadId: 'other' }]) {
    assert.equal(await readAcceptedReceipt(directory, other), null);
  }
  const traversal = { ...scope, threadId: '../../outside' };
  await writeAcceptedReceipt(directory, receipt(5, 'overlay', 'a'.repeat(64), traversal));
  assert.equal((await readAcceptedReceipt(directory, traversal)).revision, 5);
  assert.ok((await readdir(directory)).every(name => /^[a-f0-9]{64}$/u.test(name)));
});

test('same-context repeats are idempotent while conflicting mode or hash never overwrite', async t => {
  const { directory } = await fixture(t);
  const first = receipt(1);
  await writeAcceptedReceipt(directory, first);
  assert.deepEqual(await writeAcceptedReceipt(directory, { ...first, requestId: 'second', turnId: 'other-turn' }), first);
  await assert.rejects(writeAcceptedReceipt(directory, { ...first, mode: 'reset' }), { code: 'RECEIPT_CONFLICT' });
  await assert.rejects(writeAcceptedReceipt(directory, { ...first, compiledHash: 'b'.repeat(64) }), { code: 'RECEIPT_CONFLICT' });
  assert.deepEqual(await readAcceptedReceipt(directory, scope), first);
});

test('competing processes can commit only one hash for one revision', async t => {
  const { directory } = await fixture(t);
  const worker = `import {writeAcceptedReceipt} from ${JSON.stringify(moduleURL)};
    const input=JSON.parse(process.argv[2]);
    try {await writeAcceptedReceipt(process.argv[1],input); console.log(JSON.stringify({ok:true,hash:input.compiledHash}));}
    catch(error){console.log(JSON.stringify({ok:false,code:error.code}));}`;
  const results = await Promise.all(['a', 'b', 'c', 'd'].map(letter => run(process.execPath, ['--input-type=module', '-e', worker, directory, JSON.stringify(receipt(1, 'overlay', letter.repeat(64)))])));
  const values = results.map(result => JSON.parse(result.stdout));
  assert.equal(values.filter(value => value.ok).length, 1);
  assert.ok(values.filter(value => !value.ok).every(value => value.code === 'RECEIPT_CONFLICT'));
  assert.equal((await readAcceptedReceipt(directory, scope)).compiledHash, values.find(value => value.ok).hash);
});

test('damaged committed data and unknown scoped entries fail closed', async t => {
  const { directory } = await fixture(t);
  await writeAcceptedReceipt(directory, receipt(1));
  const scopeDirectory = join(directory, (await readdir(directory))[0]);
  const revisionDirectory = join(scopeDirectory, 'r0000000000000001');
  const acceptedFile = join(revisionDirectory, 'accepted.json');
  const original = await readFile(acceptedFile, 'utf8');
  await writeFile(acceptedFile, '{broken');
  await assert.rejects(readAcceptedReceipt(directory, scope), { code: 'RECEIPT_CORRUPT' });
  await assert.rejects(writeAcceptedReceipt(directory, receipt(2)), { code: 'RECEIPT_CORRUPT' });
  await writeFile(acceptedFile, original);
  await writeFile(join(scopeDirectory, 'unexpected.json'), '{}');
  await assert.rejects(readAcceptedReceipt(directory, scope), { code: 'RECEIPT_CORRUPT' });
});

test('uncommitted crash leftovers are not evidence and arbitrary applied/prepared records are rejected', async t => {
  const { directory } = await fixture(t);
  await writeAcceptedReceipt(directory, receipt(1));
  const scopeDirectory = join(directory, (await readdir(directory))[0]);
  const pendingRevision = join(scopeDirectory, 'r0000000000000002');
  await mkdir(pendingRevision);
  await writeFile(join(pendingRevision, `.pending-${process.pid}-00000000-0000-4000-8000-000000000000`), '{partial');
  assert.equal((await readAcceptedReceipt(directory, scope)).revision, 1);
  await assert.rejects(writeAcceptedReceipt(directory, { ...receipt(2), status: 'applied' }), { code: 'RECEIPT_INVALID' });
  await assert.rejects(writeAcceptedReceipt(directory, { ...receipt(2), arbitraryEvidence: 'trust me' }), { code: 'RECEIPT_INVALID' });
});
