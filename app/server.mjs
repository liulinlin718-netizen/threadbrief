import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPanelService } from './lib/panel-service.mjs';
import { catalogFromSnapshot } from './lib/catalog-snapshot.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const bindingPath = flag('--binding');
if (!bindingPath) throw new Error('Usage: node server.mjs --binding <thread-binding.json> [--port 6300]');
const binding = JSON.parse(await readFile(path.resolve(bindingPath), 'utf8'));
const runtimeDirectory = path.join(root, '.runtime');
await mkdir(runtimeDirectory, { recursive: true });
let panelToken;
try {
  const previous = JSON.parse(await readFile(path.join(runtimeDirectory, 'server.json'), 'utf8'));
  const previousUrl = new URL(previous?.url);
  if (previous.threadId === binding.threadId && previous.hostId === binding.hostId && previous.accountScope === binding.accountScope && previousUrl.hostname === '127.0.0.1' && /^\/panel\/[A-Za-z0-9_-]{32}$/.test(previousUrl.pathname)) panelToken = previousUrl.pathname.split('/')[2];
} catch (error) {
  // This is disposable service metadata. Durable card tokens are also kept in
  // the task registry; a truncated cache must not prevent service recovery.
  if (error.code !== 'ENOENT' && error.code !== 'ERR_INVALID_URL' && !(error instanceof SyntaxError)) throw error;
}
let catalog = [];
try {
  const snapshot = JSON.parse(await readFile(path.join(root, 'host-probe', 'catalog-snapshot.json'), 'utf8'));
  catalog = catalogFromSnapshot(snapshot, binding.threadId);
} catch (error) {
  // A fresh installation learns its catalog from the native adapter.
  if (error.code !== 'ENOENT') throw error;
}
const registryDirectory = path.resolve(flag('--registry') || path.join(runtimeDirectory, 'thread-bindings'));
const nativeEvidenceDirectory = flag('--native-evidence') ? path.resolve(flag('--native-evidence')) : undefined;
const bridgeDirectory = flag('--bridge-directory') ? path.resolve(flag('--bridge-directory')) : undefined;
if (Boolean(nativeEvidenceDirectory) !== Boolean(bridgeDirectory)) throw new TypeError('--native-evidence and --bridge-directory must be provided together');
const service = await createPanelService({ binding, dataDirectory: path.join(root, 'data'), evidenceDirectory: runtimeDirectory, registryDirectory, nativeEvidenceDirectory, bridgeDirectory, port: Number(flag('--port') || 6300), catalog, panelToken });
const metadataFile = path.join(runtimeDirectory, 'server.json');
const temporary = `${metadataFile}.${randomUUID()}.tmp`;
try {
  await writeFile(temporary, JSON.stringify({ pid: process.pid, url: service.url, registryDirectory, nativeEvidenceDirectory, bridgeDirectory, threadId: binding.threadId, hostId: binding.hostId, accountScope: binding.accountScope, startedAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
  await rename(temporary, metadataFile);
} finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
console.log(JSON.stringify({ service: 'ThreadBrief', url: service.url, threadId: binding.threadId }));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await service.close(); process.exit(0); });
