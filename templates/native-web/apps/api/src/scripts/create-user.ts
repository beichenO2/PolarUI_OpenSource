import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAuthRepository } from '../auth/repository.js';
import { createAuthService } from '../auth/service.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';

interface RunCreateUserOptions {
  argv: string[];
  environment?: Record<string, string | undefined>;
  writeOut?: (value: string) => void;
  writeErr?: (value: string) => void;
}

function parseArguments(argv: string[]) {
  const values = new Map<string, string>();
  let verified = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--verified') {
      verified = true;
      continue;
    }
    if (['--email', '--username', '--password'].includes(argument)) {
      const value = argv[index + 1];
      if (!value) return null;
      values.set(argument, value);
      index += 1;
      continue;
    }
    return null;
  }
  const email = values.get('--email');
  const username = values.get('--username');
  const password = values.get('--password');
  if (!email || !username || !password || !verified) return null;
  return { email, username, password };
}

export async function runCreateUser(options: RunCreateUserOptions): Promise<number> {
  const writeOut = options.writeOut ?? ((value) => process.stdout.write(value + '\n'));
  const writeErr = options.writeErr ?? ((value) => process.stderr.write(value + '\n'));
  const input = parseArguments(options.argv);
  if (!input) {
    writeErr('Required: --email EMAIL --username USER --password PASSWORD --verified');
    return 2;
  }

  let config;
  try {
    config = loadConfig(options.environment);
  } catch {
    writeErr('Identity configuration is invalid');
    return 2;
  }
  const pool = createPool(config.databaseUrl);
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    await runMigrations({
      pool,
      migrationsDir: resolve(here, '../../../../db/migrations'),
    });
    const service = createAuthService({
      repository: createAuthRepository(pool),
      mailer: { async sendVerification() {} },
      pepper: config.authPepper,
      productName: 'Polar Workflow',
    });
    const result = await service.createVerifiedAdminUser(input);
    if (!result.ok) {
      writeErr('User creation failed: ' + result.code);
      return 3;
    }
    writeOut('Created verified user: ' + result.user.username);
    return 0;
  } catch {
    writeErr('User creation failed');
    return 1;
  } finally {
    await pool.end();
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entryPath === import.meta.url) {
  process.exitCode = await runCreateUser({ argv: process.argv.slice(2) });
}
