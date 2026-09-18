import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogFromSnapshot } from '../lib/catalog-snapshot.mjs';
test('configuration snapshot preserves provenance, dependency and unknown runtime status', () => {
  const snapshot = { binding: { threadId: 't1' }, observedAt: '2026-09-17T09:49:29Z', items: [
    { id: 'plugin:p', name: 'P', kind: 'plugin', configuredEnabled: false },
    { id: 'skill:s', name: 'S', kind: 'skill', configuredEnabled: true },
  ], ownership: [{ parentId: 'plugin:p', childId: 'skill:s' }] };
  const result = catalogFromSnapshot(snapshot, 't1');
  assert.equal(result[0].defaultEnabled, false);
  assert.equal(result[1].parentId, 'plugin:p');
  assert.equal(result[1].effective, null);
  assert.equal(result[1].control, 'preference-only');
  assert.throws(() => catalogFromSnapshot(snapshot, 'other'), /another task/);
});
