import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { parseProductManifest, type ProductManifest } from '@polar/native-web-product-sdk';
import type { AuthService } from './auth/service.js';
import type { NativeWebConfig } from './config.js';
import type { DomainService } from './domain/service.js';
import type { CommandRepository } from './commands/repository.js';
import type { CommandService } from './commands/service.js';
import type { AssetService } from './assets/service.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCommandRoutes } from './routes/commands.js';
import { registerDomainRoutes } from './routes/domain.js';
import { registerAssetRoutes } from './routes/assets.js';
import type { MemoryService } from './memory/service.js';
import { registerMemoryRoutes } from './routes/memory.js';
import type { ArchiveRepository } from './archive/repository.js';
import { registerArchiveRoutes } from './routes/archive.js';

export function buildApp(options: {
  manifest: unknown;
  staticRoot: string | null;
  config?: NativeWebConfig;
  authService?: AuthService;
  domainService?: DomainService;
  commandService?: CommandService;
  commandRepository?: CommandRepository;
  assetService?: AssetService;
  memoryService?: MemoryService;
  archiveRepository?: ArchiveRepository;
  readiness?: { check(): Promise<boolean> };
}) {
  const manifest: ProductManifest = parseProductManifest(options.manifest);
  const app = Fastify({ logger: false, trustProxy: options.config?.trustProxy ?? false, bodyLimit: 26 * 1024 * 1024 });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error
      ? Number(error.statusCode)
      : 500;
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'REQUEST_REJECTED';
    if (statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: { code } });
    }
    if (request.url.startsWith('/api/auth/')) {
      request.log.error(error);
      return reply.code(503).send({ error: { code: 'AUTH_SERVICE_UNAVAILABLE' } });
    }
    if (
      request.url.startsWith('/api/commands') ||
      request.url.startsWith('/api/workflow/commands') ||
      (request.url.startsWith('/api/threads') && request.url.includes('/commands'))
    ) {
      request.log.error(error);
      return reply.code(503).send({ error: { code: 'COMMAND_SERVICE_UNAVAILABLE' } });
    }
    if (
      request.url.startsWith('/api/contexts') ||
      request.url.startsWith('/api/routes') ||
      request.url.startsWith('/api/conversations') ||
      request.url.startsWith('/api/threads')
    ) {
      request.log.error(error);
      return reply.code(503).send({ error: { code: 'DOMAIN_SERVICE_UNAVAILABLE' } });
    }
    if (request.url.startsWith('/api/memory')) {
      request.log.error(error);
      return reply.code(503).send({ error: { code: 'MEMORY_SERVICE_UNAVAILABLE' } });
    }
    return reply.send(error);
  });

  app.get('/healthz', async () => ({ ok: true, service: 'polar-web' }));
  app.get('/readyz', async (_request, reply) => {
    const ready = await (options.readiness?.check() ?? Promise.resolve(true));
    return ready
      ? { ok: true, service: 'polar-web' }
      : reply.code(503).send({ ok: false, service: 'polar-web' });
  });
  const publicManifest = {
    ...manifest,
    workflow: { id: manifest.workflow.id },
  };
  app.get('/api/bootstrap', async () => ({ manifest: publicManifest }));

  if (options.config && options.authService) {
    app.register(fastifyCookie);
    app.register(fastifyRateLimit, { global: false });
    app.register(registerAuthRoutes, {
      config: options.config,
      authService: options.authService,
    });
    if (options.domainService) {
      app.register(registerDomainRoutes, {
        config: options.config,
        authService: options.authService,
        domainService: options.domainService,
      });
    }
    if (options.commandService && options.commandRepository) {
      app.register(registerCommandRoutes, {
        config: options.config,
        authService: options.authService,
        commandService: options.commandService,
        commandRepository: options.commandRepository,
      });
    }
    if (options.assetService) {
      app.register(registerAssetRoutes, {
        config: options.config,
        authService: options.authService,
        assetService: options.assetService,
      });
    }
    if (options.memoryService) {
      app.register(registerMemoryRoutes, {
        config: options.config,
        authService: options.authService,
        memoryService: options.memoryService,
      });
    }
    if (options.archiveRepository) {
      app.register(registerArchiveRoutes, {
        config: options.config,
        authService: options.authService,
        archiveRepository: options.archiveRepository,
      });
    }
  }

  if (options.staticRoot) {
    app.register(fastifyStatic, { root: options.staticRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
