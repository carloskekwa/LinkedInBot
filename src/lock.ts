import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export function acquireLock(path: string): () => void {
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error('Invalid lock file; inspect it manually before removing');
    }
    try {
      process.kill(pid, 0);
      throw new Error(`Another bot process (${pid}) holds the lock`);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
      unlinkSync(path);
    }
  }
  writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
  return () => {
    if (readFileSync(path, 'utf8') !== String(process.pid)) {
      throw new Error('Lock ownership changed; refusing removal');
    }
    unlinkSync(path);
  };
}
