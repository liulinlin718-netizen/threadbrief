import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPanelService } from '../lib/panel-service.mjs';

test('restarting a panel preserves its local address and saved task configuration', async t => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'threadbrief-restart-'));
  const binding = { threadId: '11111111-2222-4333-8444-555555555555', hostId: 'restart-test', accountScope: 'test' };
  let service;
  t.after(async () => { if (service) await service.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  service = await createPanelService({ binding, dataDirectory });
  const beforeUrl = service.url;
  const port = Number(new URL(service.origin).port);
  const panelToken = new URL(beforeUrl).pathname.split('/')[2];
  await service.store.save(service.scope, { expectedRevision: 0, persona: '保存后重开', background: '', overrides: {} });
  await service.close();
  service = null;
  service = await createPanelService({ binding, dataDirectory, port, panelToken });
  assert.equal(service.url, beforeUrl);
  const state = await (await fetch(beforeUrl + '/api/state')).json();
  assert.equal(state.config.persona, '保存后重开');
  assert.equal(state.config.revision, 1);
  assert.equal(state.integration.context.status, 'not-connected');
});
