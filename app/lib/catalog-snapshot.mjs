// A configured snapshot is never a statement about a loaded model turn.
export function catalogFromSnapshot(snapshot, threadId) {
  if (snapshot?.binding?.threadId !== threadId || !Array.isArray(snapshot.items)) throw new TypeError('Catalog snapshot belongs to another task');
  const ownership = snapshot.ownership || [];
  return snapshot.items.map(item => ({
    id: item.id, name: item.name, kind: item.kind,
    defaultEnabled: item.configuredEnabled === true,
    available: true,
    effective: null,
    control: 'preference-only',
    source: `本机配置快照 · ${snapshot.observedAt.slice(0, 10)}`,
    reason: '此任务的执行状态未确认',
    ...(ownership.find(link => link.childId === item.id) ? { parentId: ownership.find(link => link.childId === item.id).parentId } : {}),
    ...(item.kind === 'plugin' ? { childIds: ownership.filter(link => link.parentId === item.id).map(link => link.childId) } : {}),
  }));
}
