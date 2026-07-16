import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPool } from '../db/pool.js';
import { createArchiveRepository } from '../archive/repository.js';
import { importLibreChat } from '../archive/import-librechat.js';
import { createAssetRepository } from '../assets/repository.js';
import { createAssetService } from '../assets/service.js';
import { createLocalObjectStore } from '../assets/storage.js';
import { readLibreChatMongo } from '../archive/mongo-source.js';

function value(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const input = value('--input');
const mongoUri = process.env.LIBRECHAT_MONGO_URI;
const sourceUser = value('--source-user');
const target = value('--target-user');
const attachmentsDirectory = value('--attachments-dir') ?? '.';
if ((!input && !mongoUri) || (input && mongoUri) || !target || !process.env.DATABASE_URL) {
  throw new Error('usage: import:librechat (--input export.json | LIBRECHAT_MONGO_URI=...) --target-user <id|email|username> [--source-user legacy-id] [--attachments-dir dir] [--dry-run]');
}
const pool = createPool(process.env.DATABASE_URL);
try {
  const repository = createArchiveRepository(pool);
  const userId = await repository.findUser(target);
  if (!userId) throw new Error('target user not found');
  const source = input
    ? JSON.parse(await readFile(resolve(input), 'utf8'))
    : readLibreChatMongo({ uri: mongoUri!, sourceUser });
  const assetService = createAssetService({
    repository: createAssetRepository(pool),
    store: createLocalObjectStore(process.env.OBJECT_STORE_DIRECTORY ?? '/data/objects'),
  });
  const report = await importLibreChat({
    userId, source, attachmentsDirectory: resolve(attachmentsDirectory), repository, assetService,
    dryRun: process.argv.includes('--dry-run'),
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.failures.length) process.exitCode = 2;
} finally {
  await pool.end();
}
