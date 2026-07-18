export type MemoryScope = 'user' | 'context';
export type MemoryStatus = 'active' | 'invalidated';

export interface MemorySource {
  kind: 'workflow' | 'user';
  commandId?: string;
  conversationId?: string;
}

export interface MemoryEvidence {
  kind: string;
  id: string;
  excerpt?: string;
}

export interface MemoryImpactScope {
  contextIds: string[] | 'all';
}

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  contextId: string | null;
  key: string;
  value: unknown;
  status: MemoryStatus;
  version: number;
  source: MemorySource;
  evidence: MemoryEvidence[];
  impactScope: MemoryImpactScope;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryItemVersion {
  memoryId: string;
  version: number;
  value: unknown;
  status: MemoryStatus;
  source: MemorySource;
  evidence: MemoryEvidence[];
  impactScope: MemoryImpactScope;
  createdAt: Date;
}

export type MemoryListInput =
  | { scope: 'user'; contextId?: never }
  | { scope: 'context'; contextId: string };

export interface ReviseMemoryInput {
  value: unknown;
  expectedVersion: number;
  evidence?: MemoryEvidence[];
}

export interface InvalidateMemoryInput {
  expectedVersion: number;
  reason: string;
}

export interface MemoryUpdate {
  scope: MemoryScope;
  key: string;
  value: unknown;
  expectedVersion?: number;
  highImpact?: boolean;
  confirmationPrompt?: string;
  evidence?: MemoryEvidence[];
  impactScope?: MemoryImpactScope;
}
