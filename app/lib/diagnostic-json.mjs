import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Mutable diagnostic snapshots only. Authorization receipts retain their own
// validation, durable commit and conflict checks; this is not a receipt store.
export async function writeDiagnosticJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    const started = Date.now();
    let pause = 5;
    while (true) {
      try { await rename(temporary, file); break; }
      catch (error) {
        // Windows readers/scanners can temporarily deny delete sharing. Retry
        // the atomic replacement; never delete the last complete snapshot.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)
          || Date.now() - started >= 1000) throw error;
        await delay(pause);
        pause = Math.min(pause * 2, 50);
      }
    }
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
