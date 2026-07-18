import type {
  InvalidateMemoryInput,
  MemoryEvidence,
  MemoryItem,
  MemoryItemVersion,
  MemoryListInput,
  ReviseMemoryInput,
} from './types.js';

export interface MemoryServiceRepository {
  list(userId: string, input: MemoryListInput): Promise<MemoryItem[]>;
  listVersions(userId: string, memoryId: string): Promise<MemoryItemVersion[] | null>;
  revise(
    userId: string,
    memoryId: string,
    input: ReviseMemoryInput,
    now: Date,
  ): Promise<MemoryItem | null>;
  invalidate(
    userId: string,
    memoryId: string,
    input: InvalidateMemoryInput,
    now: Date,
  ): Promise<MemoryItem | null>;
}

export class MemoryServiceError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number) {
    super(code);
    this.name = 'MemoryServiceError';
  }
}

function invalid(): never {
  throw new MemoryServiceError('INVALID_REQUEST', 400);
}

function expectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) invalid();
  return value;
}

function evidence(value: unknown): MemoryEvidence[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) invalid();
  return value.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) invalid();
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((key) => key !== 'kind' && key !== 'id' && key !== 'excerpt') ||
        typeof record.kind !== 'string' || record.kind.length < 1 || record.kind.length > 200 ||
        typeof record.id !== 'string' || record.id.length < 1 || record.id.length > 500 ||
        (record.excerpt !== undefined &&
          (typeof record.excerpt !== 'string' || record.excerpt.length > 2000))) {
      invalid();
    }
    return {
      kind: record.kind,
      id: record.id,
      ...(record.excerpt === undefined ? {} : { excerpt: record.excerpt as string }),
    };
  });
}

function translateRepositoryError(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error &&
      String(error.code) === 'MEMORY_VERSION_CONFLICT') {
    throw new MemoryServiceError('MEMORY_VERSION_CONFLICT', 409);
  }
  throw error;
}

export function createMemoryService(options: {
  repository: MemoryServiceRepository;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());

  async function list(userId: string, rawInput: MemoryListInput): Promise<MemoryItem[]> {
    const input = rawInput as unknown as Record<string, unknown> | null;
    if (!input || (input.scope !== 'user' && input.scope !== 'context')) invalid();
    if (input.scope === 'user') {
      if (input.contextId !== undefined) invalid();
      return options.repository.list(userId, { scope: 'user' });
    }
    if (typeof input.contextId !== 'string' || input.contextId.length === 0) invalid();
    return options.repository.list(userId, {
      scope: 'context', contextId: input.contextId,
    });
  }

  async function listVersions(userId: string, memoryId: string) {
    const versions = await options.repository.listVersions(userId, memoryId);
    if (!versions) throw new MemoryServiceError('NOT_FOUND', 404);
    return versions;
  }

  async function revise(userId: string, memoryId: string, rawInput: ReviseMemoryInput) {
    const input = rawInput as unknown as Record<string, unknown> | null;
    if (!input || !Object.hasOwn(input, 'value')) invalid();
    const normalized: ReviseMemoryInput = {
      value: input.value,
      expectedVersion: expectedVersion(input.expectedVersion),
      ...(input.evidence === undefined ? {} : { evidence: evidence(input.evidence)! }),
    };
    try {
      const item = await options.repository.revise(userId, memoryId, normalized, now());
      if (!item) throw new MemoryServiceError('NOT_FOUND', 404);
      return item;
    } catch (error) {
      if (error instanceof MemoryServiceError) throw error;
      return translateRepositoryError(error);
    }
  }

  async function invalidate(userId: string, memoryId: string, rawInput: InvalidateMemoryInput) {
    const input = rawInput as unknown as Record<string, unknown> | null;
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    if (!input || reason.length < 1 || reason.length > 2000) invalid();
    const normalized = {
      expectedVersion: expectedVersion(input.expectedVersion),
      reason,
    };
    try {
      const item = await options.repository.invalidate(userId, memoryId, normalized, now());
      if (!item) throw new MemoryServiceError('NOT_FOUND', 404);
      return item;
    } catch (error) {
      if (error instanceof MemoryServiceError) throw error;
      return translateRepositoryError(error);
    }
  }

  return { list, listVersions, revise, invalidate };
}

export type MemoryService = ReturnType<typeof createMemoryService>;
