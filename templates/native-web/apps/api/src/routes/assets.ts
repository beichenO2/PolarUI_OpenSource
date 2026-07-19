import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import { clearSessionCookie, hasValidOrigin, readSessionToken } from '../auth/session.js';
import type { AssetService } from '../assets/service.js';
import type { NativeWebConfig } from '../config.js';

const conversationParams = z.object({ conversationId: z.string().uuid() }).strict();
const stagedAttachmentParams = z.object({ attachmentId: z.string().uuid() }).strict();
const stageArtifactParams = z.object({
  routeId: z.string().uuid(),
  stageKey: z.string().regex(/^[a-z][a-z0-9_]*$/),
}).strict();
const assetParams = z.object({ kind: z.enum(['attachment', 'artifact', 'archive']), assetId: z.string().uuid() }).strict();

function safeDisposition(filename: string) {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function registerAssetRoutes(app: FastifyInstance, options: {
  config: NativeWebConfig; authService: AuthService; assetService: AssetService;
}) {
  const { config, authService, assetService } = options;
  async function user(request: FastifyRequest, reply: FastifyReply) {
    const token = readSessionToken(request, config.cookie.name);
    const sessionUser = token ? await authService.getSessionUser(token) : null;
    if (!sessionUser) {
      if (token) clearSessionCookie(reply, config);
      reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
      return null;
    }
    return sessionUser;
  }

  app.get('/api/conversations/:conversationId/attachments', async (request, reply) => {
    const sessionUser = await user(request, reply);
    const params = conversationParams.safeParse(request.params);
    if (!sessionUser) return;
    if (!params.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    return assetService.listConversationAttachments(sessionUser.id, params.data.conversationId);
  });

  app.get('/api/routes/:routeId/stages/:stageKey/artifacts', async (request, reply) => {
    const sessionUser = await user(request, reply);
    const params = stageArtifactParams.safeParse(request.params);
    if (!sessionUser) return;
    if (!params.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    return assetService.listStageArtifacts(sessionUser.id, params.data.routeId, params.data.stageKey);
  });

  app.post('/api/attachments/staged', async (request, reply) => {
    if (!hasValidOrigin(request, config.publicAppOrigin)) return reply.code(403).send({ error: { code: 'INVALID_ORIGIN' } });
    const sessionUser = await user(request, reply);
    if (!sessionUser) return;
    const name = request.headers['x-file-name'];
    if (typeof name !== 'string' || !Buffer.isBuffer(request.body)) return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    let decodedName: string;
    try { decodedName = decodeURIComponent(name); }
    catch { return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } }); }
    const created = await assetService.stageAttachment(sessionUser.id, {
      filename: decodedName,
      mediaType: typeof request.headers['x-file-media-type'] === 'string'
        ? request.headers['x-file-media-type']
        : 'application/octet-stream',
      body: request.body,
    });
    return reply.code(201).send({ attachment: created });
  });

  app.delete('/api/attachments/staged/:attachmentId', async (request, reply) => {
    if (!hasValidOrigin(request, config.publicAppOrigin)) return reply.code(403).send({ error: { code: 'INVALID_ORIGIN' } });
    const sessionUser = await user(request, reply);
    const params = stagedAttachmentParams.safeParse(request.params);
    if (!sessionUser) return;
    if (!params.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    await assetService.deleteStagedAttachment(sessionUser.id, params.data.attachmentId);
    return reply.code(204).send();
  });

  app.get('/api/assets/:kind/:assetId/download', async (request, reply) => {
    const sessionUser = await user(request, reply);
    const params = assetParams.safeParse(request.params);
    if (!sessionUser) return;
    if (!params.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    const asset = await assetService.openAsset(sessionUser.id, params.data.kind, params.data.assetId);
    reply.header('Content-Type', asset.object.mediaType);
    reply.header('Content-Length', asset.object.byteSize);
    reply.header('Content-Disposition', safeDisposition(asset.filename));
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(asset.stream);
  });
}
