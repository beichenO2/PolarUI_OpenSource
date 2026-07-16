import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

export interface ObjectStore {
  put(key: string, body: Buffer): Promise<void>;
  open(key: string): Promise<{ stream: Readable; byteSize: number }>;
  exists(key: string): Promise<boolean>;
}

function safePath(root: string, key: string) {
  if (!/^[a-zA-Z0-9/_-]+$/.test(key) || key.includes('..')) throw new Error('INVALID_STORAGE_KEY');
  const path = resolve(root, key);
  if (path !== root && !path.startsWith(root + '/')) throw new Error('INVALID_STORAGE_KEY');
  return path;
}

export function createLocalObjectStore(rootDirectory: string): ObjectStore {
  const root = resolve(rootDirectory);
  return {
    async put(key, body) {
      const destination = safePath(root, key);
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(body);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true });
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
      }
    },
    async open(key) {
      const path = safePath(root, key);
      const info = await stat(path);
      if (!info.isFile()) throw new Error('OBJECT_NOT_FOUND');
      return { stream: createReadStream(path), byteSize: info.size };
    },
    async exists(key) {
      try {
        return (await stat(safePath(root, key))).isFile();
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
      }
    },
  };
}

export function objectKey(userId: string, sha256: string) {
  return join(userId, sha256.slice(0, 2), sha256);
}
