import { randomUUID } from 'node:crypto';
import type { DatabaseClient, DatabasePool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import type {
  InvalidateMemoryInput,
  MemoryEvidence,
  MemoryImpactScope,
  MemoryItem,
  MemoryItemVersion,
  MemoryListInput,
  MemoryScope,
  MemorySource,
  MemoryStatus,
  MemoryUpdate,
  ReviseMemoryInput,
} from './types.js';

interface MemoryRow {
  id: string;
  scope: MemoryScope;
  context_id: string | null;
  memory_key: string;
  item_status: MemoryStatus;
  current_version: number;
  value: unknown;
  source: unknown;
  evidence: unknown;
  impact_scope: unknown;
  created_at: Date;
  updated_at: Date;
}

interface MemoryVersionRow {
  memory_id: string;
  version: number;
  value: unknown;
  status: MemoryStatus;
  source: unknown;
  evidence: unknown;
  impact_scope: unknown;
  created_at: Date;
}

interface MemoryIdentity {
  userId: string;
  scope: MemoryScope;
  contextId: string | null;
  key: string;
}

interface PreparedUpdate {
  identity: MemoryIdentity;
  lockKey: string;
  update: MemoryUpdate;
}

export interface MemoryConflict {
  update: MemoryUpdate;
  current: MemoryItem | null;
}

export interface AppendWorkflowVersionInput {
  userId: string;
  contextId: string;
  commandId: string;
  conversationId: string;
  checkpointId: string;
  update: MemoryUpdate;
  now: Date;
}

export interface AppendWorkflowVersionsInput {
  userId: string;
  contextId: string;
  commandId: string;
  conversationId: string;
  checkpointId: string;
  updates: MemoryUpdate[];
  now: Date;
}

export type AppendWorkflowVersionsResult =
  | {
    kind: 'applied';
    items: MemoryItem[];
    references: Array<{ memoryId: string; version: number }>;
  }
  | {
    kind: 'blocked';
    reason: 'version_conflict' | 'high_impact' | 'duplicate_update';
    update: MemoryUpdate;
    current: MemoryItem | null;
  };

export class MemoryRepositoryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'MemoryRepositoryError';
  }
}

const currentColumns =
  'i.id, i.scope, i.context_id, i.memory_key, i.status AS item_status, ' +
  'i.current_version, v.value, v.source, v.evidence, v.impact_scope, ' +
  'i.created_at, i.updated_at ';

function publicSource(value: unknown): MemorySource {
  const source = value as Record<string, unknown>;
  if (source?.kind === 'workflow') {
    return {
      kind: 'workflow',
      ...(typeof source.commandId === 'string' ? { commandId: source.commandId } : {}),
      ...(typeof source.conversationId === 'string'
        ? { conversationId: source.conversationId }
        : {}),
    };
  }
  return { kind: 'user' };
}

function mapMemory(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    scope: row.scope,
    contextId: row.context_id,
    key: row.memory_key,
    value: row.value,
    status: row.item_status,
    version: row.current_version,
    source: publicSource(row.source),
    evidence: row.evidence as MemoryEvidence[],
    impactScope: row.impact_scope as MemoryImpactScope,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: MemoryVersionRow): MemoryItemVersion {
  return {
    memoryId: row.memory_id,
    version: row.version,
    value: row.value,
    status: row.status,
    source: publicSource(row.source),
    evidence: row.evidence as MemoryEvidence[],
    impactScope: row.impact_scope as MemoryImpactScope,
    createdAt: row.created_at,
  };
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function lockKey(identity: MemoryIdentity): string {
  return JSON.stringify([
    identity.userId,
    identity.scope,
    identity.contextId,
    identity.key,
  ]);
}

function identityFor(userId: string, contextId: string, update: MemoryUpdate): MemoryIdentity {
  if ((update.scope !== 'user' && update.scope !== 'context') ||
      typeof update.key !== 'string' || update.key.length < 1 || update.key.length > 200) {
    throw new MemoryRepositoryError('MEMORY_IDENTITY_INVALID');
  }
  return {
    userId,
    scope: update.scope,
    contextId: update.scope === 'context' ? contextId : null,
    key: update.key,
  };
}

async function ownsContext(client: DatabaseClient, userId: string, contextId: string) {
  const result = await client.query(
    'SELECT 1 FROM contexts WHERE id = $1 AND user_id = $2',
    [contextId, userId],
  );
  return result.rows.length === 1;
}

async function acquireIdentityLock(client: DatabaseClient, identity: MemoryIdentity) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey(identity)]);
}

async function findCurrentByIdentity(
  client: DatabaseClient,
  identity: MemoryIdentity,
  forUpdate: boolean,
): Promise<MemoryItem | null> {
  const result = await client.query<MemoryRow>(
    'SELECT ' + currentColumns +
    'FROM memory_items i JOIN memory_item_versions v ' +
    'ON v.memory_id = i.id AND v.version = i.current_version ' +
    'WHERE i.user_id = $1 AND i.scope = $2 ' +
    'AND i.context_id IS NOT DISTINCT FROM $3 AND i.memory_key = $4 ' +
    (forUpdate ? 'FOR UPDATE OF i' : ''),
    [identity.userId, identity.scope, identity.contextId, identity.key],
  );
  return result.rows[0] ? mapMemory(result.rows[0]) : null;
}

async function findCurrentById(
  client: DatabaseClient,
  userId: string,
  memoryId: string,
  forUpdate: boolean,
): Promise<MemoryItem | null> {
  const result = await client.query<MemoryRow>(
    'SELECT ' + currentColumns +
    'FROM memory_items i JOIN memory_item_versions v ' +
    'ON v.memory_id = i.id AND v.version = i.current_version ' +
    'WHERE i.id = $1 AND i.user_id = $2 ' +
    (forUpdate ? 'FOR UPDATE OF i' : ''),
    [memoryId, userId],
  );
  return result.rows[0] ? mapMemory(result.rows[0]) : null;
}

async function appendVersionWithClient(
  client: DatabaseClient,
  identity: MemoryIdentity,
  current: MemoryItem | null,
  input: {
    value: unknown;
    status: MemoryStatus;
    source: Record<string, unknown>;
    evidence: MemoryEvidence[];
    impactScope: MemoryImpactScope;
    now: Date;
  },
): Promise<MemoryItem> {
  const memoryId = current?.id ?? randomUUID();
  const version = (current?.version ?? 0) + 1;
  if (!current) {
    await client.query(
      'INSERT INTO memory_items ' +
      '(id, user_id, scope, context_id, memory_key, status, current_version, created_at, updated_at) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)',
      [memoryId, identity.userId, identity.scope, identity.contextId, identity.key,
        input.status, version, input.now],
    );
  }
  await client.query(
    'INSERT INTO memory_item_versions ' +
    '(id, memory_id, version, value, status, source, evidence, impact_scope, created_at) ' +
    'VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)',
    [randomUUID(), memoryId, version, json(input.value), input.status, json(input.source),
      json(input.evidence), json(input.impactScope), input.now],
  );
  if (current) {
    await client.query(
      'UPDATE memory_items SET status = $3, current_version = $4, updated_at = $5 ' +
      'WHERE id = $1 AND user_id = $2',
      [memoryId, identity.userId, input.status, version, input.now],
    );
  }
  const stored = await findCurrentById(client, identity.userId, memoryId, false);
  if (!stored) throw new MemoryRepositoryError('MEMORY_WRITE_FAILED');
  return stored;
}

function expectedVersionMatches(update: MemoryUpdate, current: MemoryItem | null) {
  return current
    ? update.expectedVersion === current.version
    : update.expectedVersion === undefined;
}

function defaultImpactScope(update: MemoryUpdate, contextId: string): MemoryImpactScope {
  return update.impactScope ?? {
    contextIds: update.scope === 'user' ? 'all' : [contextId],
  };
}

export async function listForWorkflowWithClient(
  client: DatabaseClient,
  userId: string,
  contextId: string,
): Promise<{ user: MemoryItem[]; context: MemoryItem[] }> {
  if (!await ownsContext(client, userId, contextId)) return { user: [], context: [] };
  const result = await client.query<MemoryRow>(
    'SELECT ' + currentColumns +
    'FROM memory_items i JOIN memory_item_versions v ' +
    'ON v.memory_id = i.id AND v.version = i.current_version ' +
    "WHERE i.user_id = $1 AND i.status = 'active' AND (" +
    "(i.scope = 'user' AND i.context_id IS NULL) OR " +
    "(i.scope = 'context' AND i.context_id = $2)) " +
    'ORDER BY i.scope DESC, i.updated_at DESC, i.id',
    [userId, contextId],
  );
  const items = result.rows.map(mapMemory);
  return {
    user: items.filter((item) => item.scope === 'user'),
    context: items.filter((item) => item.scope === 'context'),
  };
}

export async function appendWorkflowVersionsWithClient(
  client: DatabaseClient,
  input: AppendWorkflowVersionsInput,
): Promise<AppendWorkflowVersionsResult> {
  if (!await ownsContext(client, input.userId, input.contextId)) {
    throw new MemoryRepositoryError('MEMORY_CONTEXT_NOT_FOUND');
  }
  const prepared: PreparedUpdate[] = input.updates.map((update) => {
    const identity = identityFor(input.userId, input.contextId, update);
    return { identity, lockKey: lockKey(identity), update };
  });
  const identities = new Map(prepared.map((item) => [item.lockKey, item.identity]));
  for (const key of [...identities.keys()].sort()) {
    await acquireIdentityLock(client, identities.get(key)!);
  }
  const currentByKey = new Map<string, MemoryItem | null>();
  for (const key of [...identities.keys()].sort()) {
    currentByKey.set(
      key,
      await findCurrentByIdentity(client, identities.get(key)!, true),
    );
  }

  const seen = new Set<string>();
  for (const item of prepared) {
    const current = currentByKey.get(item.lockKey) ?? null;
    if (seen.has(item.lockKey)) {
      return { kind: 'blocked', reason: 'duplicate_update', update: item.update, current };
    }
    seen.add(item.lockKey);
    if (item.update.highImpact) {
      return { kind: 'blocked', reason: 'high_impact', update: item.update, current };
    }
    if (!expectedVersionMatches(item.update, current)) {
      return { kind: 'blocked', reason: 'version_conflict', update: item.update, current };
    }
  }

  const source = {
    kind: 'workflow',
    commandId: input.commandId,
    conversationId: input.conversationId,
    checkpointId: input.checkpointId,
  };
  const items: MemoryItem[] = [];
  for (const item of prepared) {
    items.push(await appendVersionWithClient(
      client,
      item.identity,
      currentByKey.get(item.lockKey) ?? null,
      {
        value: item.update.value,
        status: 'active',
        source,
        evidence: item.update.evidence ?? [],
        impactScope: defaultImpactScope(item.update, input.contextId),
        now: input.now,
      },
    ));
  }
  return {
    kind: 'applied',
    items,
    references: items.map((item) => ({ memoryId: item.id, version: item.version })),
  };
}

export function createMemoryRepository(pool: DatabasePool) {
  async function list(userId: string, input: MemoryListInput): Promise<MemoryItem[]> {
    const contextId = input.scope === 'context' ? input.contextId : null;
    const result = await pool.query<MemoryRow>(
      'SELECT ' + currentColumns +
      'FROM memory_items i JOIN memory_item_versions v ' +
      'ON v.memory_id = i.id AND v.version = i.current_version ' +
      'WHERE i.user_id = $1 AND i.scope = $2 ' +
      'AND i.context_id IS NOT DISTINCT FROM $3 ' +
      'ORDER BY i.updated_at DESC, i.id',
      [userId, input.scope, contextId],
    );
    return result.rows.map(mapMemory);
  }

  async function listVersions(
    userId: string,
    memoryId: string,
  ): Promise<MemoryItemVersion[] | null> {
    const owner = await pool.query(
      'SELECT 1 FROM memory_items WHERE id = $1 AND user_id = $2',
      [memoryId, userId],
    );
    if (!owner.rows[0]) return null;
    const result = await pool.query<MemoryVersionRow>(
      'SELECT v.memory_id, v.version, v.value, v.status, v.source, v.evidence, ' +
      'v.impact_scope, v.created_at FROM memory_item_versions v ' +
      'WHERE v.memory_id = $1 ORDER BY v.version',
      [memoryId],
    );
    return result.rows.map(mapVersion);
  }

  async function listForWorkflow(userId: string, contextId: string) {
    return withTransaction(pool, (client) => listForWorkflowWithClient(client, userId, contextId));
  }

  async function revise(
    userId: string,
    memoryId: string,
    input: ReviseMemoryInput,
    now: Date,
  ): Promise<MemoryItem | null> {
    return withTransaction(pool, async (client) => {
      const identityResult = await client.query<{
        scope: MemoryScope;
        context_id: string | null;
        memory_key: string;
      }>(
        'SELECT scope, context_id, memory_key FROM memory_items WHERE id = $1 AND user_id = $2',
        [memoryId, userId],
      );
      const row = identityResult.rows[0];
      if (!row) return null;
      const identity = { userId, scope: row.scope, contextId: row.context_id, key: row.memory_key };
      await acquireIdentityLock(client, identity);
      const current = await findCurrentById(client, userId, memoryId, true);
      if (!current) return null;
      if (current.version !== input.expectedVersion) {
        throw new MemoryRepositoryError('MEMORY_VERSION_CONFLICT');
      }
      return appendVersionWithClient(client, identity, current, {
        value: input.value,
        status: 'active',
        source: { kind: 'user' },
        evidence: input.evidence ?? [],
        impactScope: current.impactScope,
        now,
      });
    });
  }

  async function invalidate(
    userId: string,
    memoryId: string,
    input: InvalidateMemoryInput,
    now: Date,
  ): Promise<MemoryItem | null> {
    return withTransaction(pool, async (client) => {
      const identityResult = await client.query<{
        scope: MemoryScope;
        context_id: string | null;
        memory_key: string;
      }>(
        'SELECT scope, context_id, memory_key FROM memory_items WHERE id = $1 AND user_id = $2',
        [memoryId, userId],
      );
      const row = identityResult.rows[0];
      if (!row) return null;
      const identity = { userId, scope: row.scope, contextId: row.context_id, key: row.memory_key };
      await acquireIdentityLock(client, identity);
      const current = await findCurrentById(client, userId, memoryId, true);
      if (!current) return null;
      if (current.version !== input.expectedVersion) {
        throw new MemoryRepositoryError('MEMORY_VERSION_CONFLICT');
      }
      return appendVersionWithClient(client, identity, current, {
        value: null,
        status: 'invalidated',
        source: { kind: 'user' },
        evidence: [{ kind: 'invalidation_reason', id: 'user', excerpt: input.reason }],
        impactScope: current.impactScope,
        now,
      });
    });
  }

  async function detectConflict(input: {
    userId: string;
    contextId: string;
    update: MemoryUpdate;
  }): Promise<MemoryConflict | null> {
    return withTransaction(pool, async (client) => {
      if (!await ownsContext(client, input.userId, input.contextId)) {
        throw new MemoryRepositoryError('MEMORY_CONTEXT_NOT_FOUND');
      }
      const identity = identityFor(input.userId, input.contextId, input.update);
      const current = await findCurrentByIdentity(client, identity, false);
      return expectedVersionMatches(input.update, current)
        ? null
        : { update: input.update, current };
    });
  }

  async function appendWorkflowVersion(input: AppendWorkflowVersionInput): Promise<MemoryItem> {
    return withTransaction(pool, async (client) => {
      const result = await appendWorkflowVersionsWithClient(client, {
        ...input,
        updates: [input.update],
      });
      if (result.kind === 'blocked') {
        throw new MemoryRepositoryError(
          result.reason === 'high_impact'
            ? 'MEMORY_CONFIRMATION_REQUIRED'
            : 'MEMORY_VERSION_CONFLICT',
        );
      }
      return result.items[0]!;
    });
  }

  return {
    list,
    listVersions,
    listForWorkflow,
    revise,
    invalidate,
    detectConflict,
    appendWorkflowVersion,
  };
}

export type MemoryRepository = ReturnType<typeof createMemoryRepository>;
