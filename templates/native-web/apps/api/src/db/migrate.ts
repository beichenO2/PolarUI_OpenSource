import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DatabasePool } from './pool.js';

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_ID = '7046029254386353131';

interface Migration {
  version: string;
  checksum: string;
  sql: string;
}

export interface RunMigrationsOptions {
  pool: DatabasePool;
  migrationsDir: string;
}

async function loadMigrations(migrationsDir: string): Promise<Migration[]> {
  const fileNames = (await readdir(migrationsDir))
    .filter((fileName) => MIGRATION_FILE_PATTERN.test(fileName))
    .sort();

  return Promise.all(fileNames.map(async (fileName) => {
    const sql = await readFile(join(migrationsDir, fileName), 'utf8');
    return {
      version: basename(fileName, '.sql'),
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
    };
  }));
}

export async function runMigrations({
  pool,
  migrationsDir,
}: RunMigrationsOptions): Promise<void> {
  const migrations = await loadMigrations(migrationsDir);
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_ID]);
    lockAcquired = true;
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (' +
        'version text PRIMARY KEY, ' +
        'checksum text NOT NULL, ' +
        'applied_at timestamptz NOT NULL DEFAULT now()' +
      ')',
    );

    for (const migration of migrations) {
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [migration.version],
      );

      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== migration.checksum) {
          throw new Error('Migration checksum mismatch: ' + migration.version);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [migration.version, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    if (lockAcquired) {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_ID]);
    }
    client.release();
  }
}
