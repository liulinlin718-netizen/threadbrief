import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { createPanelService } from '../lib/panel-service.mjs';

const binding = { threadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', hostId: 'local-test', accountScope: 'test-only', title: '测试任务' };
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'threadbrief-api-'));
  const app = await createPanelService({ binding, dataDirectory: path.join(directory, 'data') });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...app, directory };
}
function send(app, route, body, method = 'PUT', extra = {}) {
  return fetch(app.url + route, { method, headers: { 'Content-Type': 'application/json', Origin: app.origin, ...extra }, body: JSON.stringify(body) });
}
test('opening a real binding is empty and never writes configuration', async t => {
  const app = await fixture(t);
  const response = await fetch(app.url + '/api/state');
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.thread.id, binding.threadId);
  assert.equal(state.config.revision, 0);
  assert.equal(state.historyRevision, 0);
  assert.deepEqual(state.history, []);
  assert.equal(state.integration.context.status, 'not-connected');
  assert.deepEqual(state.catalog, []);
  assert.deepEqual(await readdir(app.directory), []);
});
test('save, stale-tab conflict and rollback are scoped and durable', async t => {
  const app = await fixture(t);
  const save = await send(app, '/api/config', { expectedRevision: 0, persona: '代码审阅者', background: '仅检查有证据的问题', overrides: { 'skill.review': 'on' }, threadId: 'forged-other-thread' });
  assert.equal(save.status, 200);
  const saved = await save.json();
  assert.equal(saved.config.revision, 1);
  assert.equal(saved.thread.id, binding.threadId);
  assert.equal(saved.integration.context.status, 'not-connected');
  const conflict = await send(app, '/api/config', { expectedRevision: 0, persona: '', background: '', overrides: {} });
  assert.equal(conflict.status, 409);
  const rollback = await send(app, '/api/rollback', { expectedRevision: 1, targetRevision: 0 }, 'POST');
  assert.equal(rollback.status, 200);
  const restored = await rollback.json();
  assert.equal(restored.config.persona, '');
  assert.equal(restored.config.revision, 2);
});
test('cross-site mutation, invalid token, traversal and forged host are rejected', async t => {
  const app = await fixture(t);
  const body = { expectedRevision: 0, persona: 'bad', background: '', overrides: {} };
  assert.equal((await send(app, '/api/config', body, 'PUT', { Origin: 'https://outside.example' })).status, 403);
  assert.equal((await fetch(app.origin + '/panel/invalid/api/state')).status, 404);
  assert.equal((await fetch(app.origin + '/assets/../server.mjs')).status, 404);
  const forgedStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(app.url + '/api/state', { headers: { Host: 'outside.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(forgedStatus, 403);
  assert.equal((await app.store.get(app.scope)).revision, 0);
});
test('page-visible receipt never claims context or capability application', async t => {
  const app = await fixture(t);
  assert.equal((await send(app, '/api/visible', { width: 380, height: 800, visibility: 'visible' }, 'POST')).status, 200);
  const state = await (await fetch(app.url + '/api/state')).json();
  assert.equal(state.integration.mount.status, 'page-observed');
  assert.equal(state.integration.context.status, 'not-connected');
  assert.equal(state.integration.capabilities.status, 'not-connected');
});

test('version rename and deletion persist through API without changing task configuration', async t => {
  const app = await fixture(t);
  await send(app, '/api/config', { expectedRevision: 0, persona: 'First', background: '', overrides: {} });
  const saved = await (await send(app, '/api/config', { expectedRevision: 1, persona: 'Second', background: '', overrides: {} })).json();
  const rename = await send(app, '/api/history/rename', { expectedRevision: 2, expectedHistoryRevision: 0, targetRevision: 1, name: '  初始人设  ', threadId: 'forged-other-thread' }, 'POST');
  assert.equal(rename.status, 200);
  const renamed = await rename.json();
  assert.deepEqual(renamed.config, saved.config);
  assert.equal(renamed.historyRevision, 1);
  assert.deepEqual(renamed.history, [
    { revision: 1, name: '初始人设', current: false, activeThreadCount: 0 },
    { revision: 2, current: true, activeThreadCount: 1 },
  ]);
  assert.deepEqual(await (await fetch(app.url + '/api/history')).json(), { historyRevision: 1, history: renamed.history });
  const remove = await send(app, '/api/history/delete', { expectedRevision: 2, expectedHistoryRevision: 1, targetRevision: 1 }, 'POST');
  assert.equal(remove.status, 200);
  const removed = await remove.json();
  assert.deepEqual(removed.config, saved.config);
  assert.equal(removed.historyRevision, 2);
  assert.deepEqual(removed.history, [{ revision: 2, current: true, activeThreadCount: 1 }]);
  const reload = await (await fetch(app.url + '/api/state')).json();
  assert.deepEqual(reload.history, removed.history);
  assert.equal(reload.historyRevision, 2);
  assert.equal((await app.store.history(app.scope)).length, 2);
  const restore = await send(app, '/api/rollback', { expectedRevision: 2, targetRevision: 1 }, 'POST');
  assert.equal(restore.status, 404);
  assert.equal((await restore.json()).code, 'REVISION_NOT_FOUND');
});

test('version API enforces metadata/configuration CAS, active version protection, and input validation', async t => {
  const app = await fixture(t);
  await send(app, '/api/config', { expectedRevision: 0, persona: 'First', background: '', overrides: {} });
  const input = { expectedRevision: 1, expectedHistoryRevision: 0, targetRevision: 1, name: 'New name' };
  assert.equal((await send(app, '/api/history/delete', input, 'POST')).status, 400);
  assert.equal((await send(app, '/api/history/rename', { ...input, name: 'New\nname' }, 'POST')).status, 400);
  assert.equal((await send(app, '/api/history/rename', { ...input, expectedHistoryRevision: undefined }, 'POST')).status, 400);
  assert.equal((await send(app, '/api/history/rename', { ...input, targetRevision: 99 }, 'POST')).status, 404);
  assert.equal((await send(app, '/api/history/rename', input, 'POST')).status, 200);
  const historyConflict = await send(app, '/api/history/rename', input, 'POST');
  assert.equal(historyConflict.status, 409);
  assert.equal((await historyConflict.json()).code, 'HISTORY_CONFLICT');
  await send(app, '/api/config', { expectedRevision: 1, persona: 'Second', background: '', overrides: {} });
  const configConflict = await send(app, '/api/history/rename', { ...input, expectedHistoryRevision: 1 }, 'POST');
  assert.equal(configConflict.status, 409);
  assert.equal((await configConflict.json()).code, 'REVISION_CONFLICT');
  assert.equal((await send(app, '/api/history/delete', { expectedRevision: 2, expectedHistoryRevision: 1, targetRevision: 1 }, 'POST', { Origin: 'https://outside.example' })).status, 403);
  assert.deepEqual((await app.state()).history, [
    { revision: 1, name: 'New name', current: false, activeThreadCount: 0 },
    { revision: 2, current: true, activeThreadCount: 1 },
  ]);
});
