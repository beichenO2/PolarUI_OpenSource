import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { parseProductManifest } from '@polar/native-web-product-sdk';
import { createAuthRepository } from './auth/repository.js';
import { createAuthService } from './auth/service.js';
import { createSmtpVerificationMailer } from './auth/mailer.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createDomainRepository } from './domain/repository.js';
import { createDomainService } from './domain/service.js';
import { createCommandRepository } from './commands/repository.js';
import { createCommandService } from './commands/service.js';
import { createWorkflowBridge } from './commands/bridge.js';
import { createAssetRepository } from './assets/repository.js';
import { createAssetService } from './assets/service.js';
import { createLocalObjectStore } from './assets/storage.js';
import { createMemoryRepository } from './memory/repository.js';
import { createArchiveRepository } from './archive/repository.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const manifestPath = process.env.PRODUCT_MANIFEST_PATH ?? join(root, 'product.manifest.json');
const staticRoot = process.env.WEB_STATIC_ROOT ?? join(root, 'apps/web/dist');
const manifest = parseProductManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
const config = loadConfig();
const pool = createPool(config.databaseUrl);
await runMigrations({ pool, migrationsDir: join(root, 'db/migrations') });
const mailer = createSmtpVerificationMailer(config.smtp);
const authRepository = createAuthRepository(pool);
const authService = createAuthService({
  repository: authRepository,
  mailer,
  pepper: config.authPepper,
  productName: manifest.product?.name ?? 'Polar Workflow',
  verificationTtlSeconds: config.verificationTtlSeconds,
  sessionTtlSeconds: config.sessionTtlSeconds,
});
if (manifest.demo_login) {
  const demoUser = await authService.ensureVerifiedDemoUser(manifest.demo_login);
  if (!demoUser.ok) {
    throw new Error(`Demo login provisioning failed: ${demoUser.code}`);
  }
}
const domainService = createDomainService({
  repository: createDomainRepository(pool),
  manifest,
});
const commandRepository = createCommandRepository(pool);
const assetService = createAssetService({
  repository: createAssetRepository(pool),
  store: createLocalObjectStore(config.objectStoreDirectory),
});
const commandService = createCommandService({
  repository: commandRepository,
  bridge: createWorkflowBridge({
    endpoint: config.workflowEndpointOverride ?? manifest.workflow.endpoint,
    workflowId: manifest.workflow.id,
    manifest,
    timeoutMs: config.workflowTimeoutMs,
    artifactRoot: config.workflowArtifactRoot,
  }),
  manifest,
  leaseDurationMs: config.workflowTimeoutMs + 30_000,
  assetService,
});
const app = buildApp({
  manifest,
  staticRoot,
  config,
  authService,
  domainService,
  commandService,
  commandRepository,
  assetService,
  memoryRepository: createMemoryRepository(pool),
  archiveRepository: createArchiveRepository(pool),
  readiness: {
    async check() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
  },
});
const port = Number(process.env.PORT ?? 3920);

await app.listen({ host: '0.0.0.0', port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    mailer.close?.();
    await pool.end();
    process.exit(0);
  });
}
