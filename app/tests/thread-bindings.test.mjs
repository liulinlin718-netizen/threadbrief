import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openThreadBindings } from '../lib/thread-bindings.mjs';
import { createPanelService } from '../lib/panel-service.mjs';

const binding = { threadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', hostId: 'registry-test-host', accountScope: 'registry-test-account', title: '原任务' };
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'threadbrief-binding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, registryDirectory: path.join(directory, 'registry'), dataDirectory: path.join(directory, 'data') };
}
const state = async url => (await fetch(url + '/api/state')).json();
function send(origin, url, route, body, method = 'PUT') {
  return fetch(url + route, { method, headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
}

test('trusted registrations retain tokens across concurrent clients and restarts', async t => {
  const { registryDirectory } = await fixture(t);
  const [a, b] = await Promise.all([1, 2].map(() => openThreadBindings({ directory: registryDirectory, binding })));
  const results = await Promise.all([a.register({ threadId: otherId, title: '子任务' }), b.register({ threadId: otherId, title: '子任务' })]);
  assert.equal(results[0].token, results[1].token);
  assert.match(results[0].token, /^[A-Za-z0-9_-]{32}$/);
  const reopened = await openThreadBindings({ directory: registryDirectory, binding });
  const updated = await reopened.register({ threadId: otherId, title: '新标题 <仅作为文本>' });
  assert.equal(updated.token, results[0].token);
  assert.equal((await a.lookup(updated.token)).title, updated.title);
  await assert.rejects(a.register({ threadId: binding.threadId }, { token: updated.token }), /another task/);
  assert.equal((await a.lookup(updated.token)).threadId, otherId);
  await assert.rejects(openThreadBindings({ directory: registryDirectory, binding: { ...binding, accountScope: 'other-account' } }), /authority/);
});

test('one loopback service isolates live registered tasks without writing defaults', async t => {
  const paths = await fixture(t);
  let app = await createPanelService({ binding, ...paths });
  t.after(async () => { if (app) await app.close(); });
  const primaryUrl = app.url;
  const primaryToken = new URL(primaryUrl).pathname.split('/')[2];
  const backend = await openThreadBindings({ directory: paths.registryDirectory, binding });
  const registered = await backend.register({ threadId: otherId, title: '独立子任务' });
  const otherUrl = app.origin + '/panel/' + registered.token;
  const [initialA, initialB] = await Promise.all([state(primaryUrl), state(otherUrl)]);
  assert.equal(initialA.thread.id, binding.threadId);
  assert.equal(initialB.thread.id, otherId);
  assert.equal(initialB.thread.title, '独立子任务');
  assert.equal(initialA.config.revision, 0);
  assert.equal(initialB.config.revision, 0);
  assert.deepEqual(initialB.catalog, []);
  await assert.rejects(readdir(paths.dataDirectory), { code: 'ENOENT' });
  const saved = await send(app.origin, otherUrl, '/api/config', { expectedRevision: 0, persona: '只属于子任务', background: '中文背景', overrides: {}, threadId: binding.threadId, hostId: 'forged', accountScope: 'forged' });
  assert.equal(saved.status, 200);
  assert.equal((await state(primaryUrl)).config.revision, 0);
  assert.equal((await state(otherUrl)).config.persona, '只属于子任务');
  const sharedFromPrimary = await (await fetch(primaryUrl + '/api/history')).json();
  const sharedFromOther = await (await fetch(otherUrl + '/api/history')).json();
  assert.deepEqual(sharedFromPrimary, { historyRevision: 0, history: [{ revision: 1, current: false, activeThreadCount: 1 }] });
  assert.deepEqual(sharedFromOther, { historyRevision: 0, history: [{ revision: 1, current: true, activeThreadCount: 1 }] });
  assert.equal((await send(app.origin, otherUrl, '/api/visible', { width: 380, height: 800, visibility: 'visible' }, 'POST')).status, 200);
  assert.equal((await state(primaryUrl)).integration.mount.status, 'waiting');
  const observed = await state(otherUrl);
  assert.equal(observed.integration.mount.status, 'page-observed');
  assert.equal(observed.integration.context.status, 'not-connected');
  assert.equal(observed.integration.capabilities.status, 'not-connected');
  const port = Number(new URL(app.origin).port);
  await app.close(); app = null;
  app = await createPanelService({ binding, ...paths, panelToken: primaryToken, port });
  assert.equal(app.url, primaryUrl);
  assert.equal((await state(otherUrl)).config.persona, '只属于子任务');
  assert.equal((await state(primaryUrl)).config.revision, 0);
});

test('browser cannot register UUIDs or use tampered local binding records', async t => {
  const paths = await fixture(t);
  const app = await createPanelService({ binding, ...paths });
  t.after(() => app.close());
  assert.equal((await send(app.origin, app.url, '/api/register', { threadId: otherId }, 'POST')).status, 404);
  assert.equal((await fetch(app.origin + '/panel/' + otherId + '/api/state')).status, 404);
  assert.equal((await fetch(app.origin + '/registry/registry.key')).status, 404);
  const entry = await app.registry.register({ threadId: otherId, title: '已登记' });
  const recordFile = path.join(paths.registryDirectory, 'panels', `${entry.token}.json`);
  const envelope = JSON.parse(await readFile(recordFile, 'utf8'));
  envelope.payload.threadId = binding.threadId;
  await writeFile(recordFile, JSON.stringify(envelope));
  const rejected = await fetch(app.origin + '/panel/' + entry.token + '/api/state');
  assert.equal(rejected.status, 400);
  await assert.rejects(readdir(paths.dataDirectory), { code: 'ENOENT' });
  assert.equal((await state(app.url)).config.revision, 0);
});
