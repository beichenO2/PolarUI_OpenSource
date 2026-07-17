import type { DatabasePool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import {
  checkpointStages,
  normalizeCheckpointSnapshot,
} from './types.js';
import type {
  CheckpointReason,
  CheckpointSnapshot,
  ContextStatus,
  LegacyCheckpointSnapshot,
  PublicScopeStatus,
  RouteStageStatus,
  StageProjection,
  ThreadStatus,
  TitleSource,
  WorkflowCheckpoint,
  WorkflowConversation,
  WorkflowContext,
  WorkflowRoute,
  WorkflowThread,
} from './types.js';

interface ContextRow {
  id: string;
  title: string;
  status: ContextStatus;
  created_at: Date;
  updated_at: Date;
}

interface RouteRow {
  id: string;
  context_id: string;
  name: string;
  origin_checkpoint_id: string | null;
  head_checkpoint_id: string;
  created_at: Date;
  updated_at: Date;
  origin_route_id?: string | null;
  origin_route_name?: string | null;
  origin_version?: number | null;
  origin_stage_key?: string | null;
}

interface RouteWorkspaceRow extends RouteRow {
  title: string;
  status: ContextStatus;
  context_created_at: Date;
  context_updated_at: Date;
}

interface StageRow {
  stage_key: string;
  position: number;
  status: RouteStageStatus;
  internal_state: string;
}

interface CheckpointRow {
  id: string;
  context_id: string;
  route_id: string;
  parent_checkpoint_id: string | null;
  version: number;
  stage_key: string | null;
  reason: CheckpointReason;
  snapshot: unknown;
  created_at: Date;
}

interface ThreadRow {
  id: string;
  context_id: string;
  route_id: string;
  stage_key: string | null;
  title: string;
  title_source: TitleSource;
  is_primary: boolean;
  status: ThreadStatus;
  created_at: Date;
  updated_at: Date;
}

function mapContext(row: ContextRow): WorkflowContext {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRoute(row: RouteRow): WorkflowRoute {
  return {
    id: row.id,
    contextId: row.context_id,
    name: row.name,
    originCheckpointId: row.origin_checkpoint_id,
    origin: row.origin_checkpoint_id && row.origin_route_id && row.origin_route_name &&
      row.origin_version !== null && row.origin_version !== undefined
      ? {
          routeId: row.origin_route_id,
          routeName: row.origin_route_name,
          version: row.origin_version,
          stageKey: row.origin_stage_key ?? null,
        }
      : null,
    headCheckpointId: row.head_checkpoint_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStage(row: StageRow): StageProjection {
  return {
    stageKey: row.stage_key,
    position: row.position,
    status: row.status,
    internalState: row.internal_state,
  };
}

function mapCheckpoint(row: CheckpointRow): WorkflowCheckpoint {
  return {
    id: row.id,
    contextId: row.context_id,
    routeId: row.route_id,
    parentCheckpointId: row.parent_checkpoint_id,
    version: row.version,
    stageKey: row.stage_key,
    reason: row.reason,
    snapshot: normalizeCheckpointSnapshot(row.snapshot),
    createdAt: row.created_at,
  };
}

function mapThread(row: ThreadRow): WorkflowThread {
  return {
    id: row.id,
    contextId: row.context_id,
    routeId: row.route_id,
    stageKey: row.stage_key,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversation(row: ThreadRow): WorkflowConversation {
  return {
    id: row.id,
    contextId: row.context_id,
    routeId: row.route_id,
    title: row.title,
    titleSource: row.title_source,
    isPrimary: row.is_primary,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function snapshotFromStages(stages: StageProjection[]): CheckpointSnapshot {
  if (stages.length === 0) {
    return {
      workflowState: {},
      memoryReferences: [],
      artifacts: [],
    };
  }
  const legacyStages = stages.map((stage) => ({
    stage_key: stage.stageKey,
    status: stage.status,
    internal_state: stage.internalState,
  }));
  const snapshot: CheckpointSnapshot & LegacyCheckpointSnapshot = {
    workflowState: {
      legacyCompatibility: {
        stages: legacyStages,
      },
    },
    stageProjection: {
      revision: 'legacy-stage-projection-v1',
      items: stages.map((stage) => ({
        key: stage.stageKey,
        label: stage.stageKey,
        status: stage.status,
        summary: stage.internalState,
      })),
    },
    memoryReferences: [],
    artifacts: [],
    stages: legacyStages,
  };
  return snapshot;
}

const routeOriginColumns =
  'origin_cp.route_id AS origin_route_id, origin_route.name AS origin_route_name, ' +
  'origin_cp.version AS origin_version, origin_cp.stage_key AS origin_stage_key';

const routeOriginJoins =
  'LEFT JOIN workflow_checkpoints origin_cp ON origin_cp.id = r.origin_checkpoint_id ' +
  'LEFT JOIN workflow_routes origin_route ON origin_route.id = origin_cp.route_id ';

export function createDomainRepository(pool: DatabasePool) {
  return {
    async createContext(input: {
      userId: string;
      contextId: string;
      title: string;
      routeId: string;
      routeName: string;
      checkpointId: string;
      stages: StageProjection[];
      now: Date;
    }) {
      return withTransaction(pool, async (client) => {
        const contextResult = await client.query<ContextRow>(
          'INSERT INTO contexts (id, user_id, title, created_at, updated_at) ' +
          'VALUES ($1, $2, $3, $4, $4) RETURNING id, title, status, created_at, updated_at',
          [input.contextId, input.userId, input.title, input.now],
        );
        await client.query(
          'INSERT INTO workflow_routes (id, context_id, name, created_at, updated_at) ' +
          'VALUES ($1, $2, $3, $4, $4)',
          [input.routeId, input.contextId, input.routeName, input.now],
        );
        for (const stage of input.stages) {
          await client.query(
            'INSERT INTO route_stage_projections ' +
            '(route_id, stage_key, position, status, internal_state, updated_at) ' +
            'VALUES ($1, $2, $3, $4, $5, $6)',
            [input.routeId, stage.stageKey, stage.position, stage.status, stage.internalState, input.now],
          );
        }
        const checkpointResult = await client.query<CheckpointRow>(
          'INSERT INTO workflow_checkpoints ' +
          '(id, context_id, route_id, version, stage_key, reason, snapshot, created_at) ' +
          "VALUES ($1, $2, $3, 0, $4, 'bootstrap', $5, $6) RETURNING *",
          [
            input.checkpointId,
            input.contextId,
            input.routeId,
            input.stages[0]?.stageKey ?? null,
            snapshotFromStages(input.stages),
            input.now,
          ],
        );
        const routeResult = await client.query<RouteRow>(
          'UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1 RETURNING *',
          [input.routeId, input.checkpointId],
        );
        return {
          context: mapContext(contextResult.rows[0]!),
          route: mapRoute(routeResult.rows[0]!),
          checkpoint: mapCheckpoint(checkpointResult.rows[0]!),
        };
      });
    },

    async listContexts(userId: string): Promise<WorkflowContext[]> {
      const result = await pool.query<ContextRow>(
        'SELECT id, title, status, created_at, updated_at FROM contexts ' +
        "WHERE user_id = $1 AND status = 'active' ORDER BY updated_at DESC, id",
        [userId],
      );
      return result.rows.map(mapContext);
    },

    async getContextWorkspace(userId: string, contextId: string) {
      const contextResult = await pool.query<ContextRow>(
        'SELECT id, title, status, created_at, updated_at FROM contexts ' +
        "WHERE id = $1 AND user_id = $2 AND status = 'active' LIMIT 1",
        [contextId, userId],
      );
      if (!contextResult.rows[0]) return null;
      const routesResult = await pool.query<RouteRow>(
        'SELECT r.*, ' + routeOriginColumns + ' ' +
        'FROM workflow_routes r ' + routeOriginJoins +
        "WHERE r.context_id = $1 AND r.status = 'active' ORDER BY r.created_at, r.id",
        [contextId],
      );
      return {
        context: mapContext(contextResult.rows[0]),
        routes: routesResult.rows.map(mapRoute),
      };
    },

    async getRouteWorkspace(userId: string, routeId: string) {
      const routeResult = await pool.query<RouteWorkspaceRow>(
        'SELECT r.*, ' + routeOriginColumns + ', ' +
        'c.title, c.status, c.created_at AS context_created_at, ' +
        'c.updated_at AS context_updated_at ' +
        'FROM workflow_routes r ' + routeOriginJoins +
        'JOIN contexts c ON c.id = r.context_id ' +
        "WHERE r.id = $1 AND c.user_id = $2 " +
        "AND r.status = 'active' AND c.status = 'active' LIMIT 1",
        [routeId, userId],
      );
      const row = routeResult.rows[0];
      if (!row) return null;
      const [checkpointsResult, conversationsResult] = await Promise.all([
        pool.query<CheckpointRow>(
          'SELECT * FROM workflow_checkpoints WHERE route_id = $1 ORDER BY version, created_at, id',
          [routeId],
        ),
        pool.query<ThreadRow>(
          'SELECT * FROM workflow_threads ' +
          "WHERE route_id = $1 AND status = 'active' " +
          'ORDER BY updated_at DESC, id',
          [routeId],
        ),
      ]);
      return {
        context: mapContext({
          id: row.context_id,
          title: row.title,
          status: row.status,
          created_at: row.context_created_at,
          updated_at: row.context_updated_at,
        }),
        route: mapRoute(row),
        checkpoints: checkpointsResult.rows.map(mapCheckpoint),
        conversations: conversationsResult.rows.map(mapConversation),
      };
    },

    async renameContext(input: {
      userId: string;
      contextId: string;
      title: string;
      now: Date;
    }): Promise<WorkflowContext | null> {
      const result = await pool.query<ContextRow>(
        "UPDATE contexts SET title = $3, title_source = 'user', updated_at = $4 " +
        'WHERE id = $1 AND user_id = $2 ' +
        'RETURNING id, title, status, created_at, updated_at',
        [input.contextId, input.userId, input.title, input.now],
      );
      return result.rows[0] ? mapContext(result.rows[0]) : null;
    },

    async createConversation(input: {
      userId: string;
      id: string;
      routeId: string;
      title: string;
      titleSource: TitleSource;
      status: PublicScopeStatus;
      now: Date;
    }): Promise<WorkflowConversation | null> {
      return withTransaction(pool, async (client) => {
        const routeResult = await client.query<{ context_id: string }>(
          'SELECT r.context_id FROM workflow_routes r ' +
          'JOIN contexts c ON c.id = r.context_id ' +
          'WHERE r.id = $1 AND c.user_id = $2 FOR UPDATE OF r',
          [input.routeId, input.userId],
        );
        const route = routeResult.rows[0];
        if (!route) return null;
        const result = await client.query<ThreadRow>(
          'INSERT INTO workflow_threads ' +
          '(id, context_id, route_id, stage_key, title, title_source, is_primary, status, created_at, updated_at) ' +
          'VALUES ($1, $2, $3, NULL, $4, $5, ' +
          "NOT EXISTS (SELECT 1 FROM workflow_threads existing WHERE existing.route_id = $3 AND existing.status <> 'archived'), " +
          '$6, $7, $7) RETURNING *',
          [input.id, route.context_id, input.routeId, input.title, input.titleSource, input.status, input.now],
        );
        if (!result.rows[0]) return null;
        await client.query(
          'UPDATE contexts SET updated_at = $2 WHERE id = $1',
          [result.rows[0].context_id, input.now],
        );
        return mapConversation(result.rows[0]);
      });
    },

    async updateConversation(input: {
      userId: string;
      conversationId: string;
      title?: string;
      status?: 'active' | 'archived';
      now: Date;
    }): Promise<WorkflowConversation | null> {
      return withTransaction(pool, async (client) => {
        const routeResult = await client.query<{ id: string; context_id: string }>(
          'SELECT r.id, r.context_id FROM workflow_routes r ' +
          'JOIN contexts c ON c.id = r.context_id ' +
          'JOIN workflow_threads t ON t.route_id = r.id AND t.context_id = r.context_id ' +
          'WHERE t.id = $1 AND c.user_id = $2 FOR UPDATE OF r',
          [input.conversationId, input.userId],
        );
        const route = routeResult.rows[0];
        if (!route) return null;
        const result = await client.query<ThreadRow>(
          'UPDATE workflow_threads t SET title = COALESCE($2, t.title), ' +
          "title_source = CASE WHEN $2 IS NULL THEN t.title_source ELSE 'user' END, " +
          'status = COALESCE($3, t.status), ' +
          'is_primary = CASE ' +
            "WHEN $3 = 'archived' THEN false " +
            "WHEN $3 = 'active' AND t.status = 'archived' THEN NOT EXISTS (" +
              'SELECT 1 FROM workflow_threads existing ' +
              'WHERE existing.route_id = $5 AND existing.id <> t.id ' +
              "AND existing.status <> 'archived' AND existing.is_primary" +
            ') ' +
            'ELSE t.is_primary ' +
          'END, updated_at = $4 ' +
          'WHERE t.id = $1 AND t.route_id = $5 AND t.context_id = $6 RETURNING t.*',
          [
            input.conversationId,
            input.title ?? null,
            input.status ?? null,
            input.now,
            route.id,
            route.context_id,
          ],
        );
        if (!result.rows[0]) return null;
        if (input.status === 'archived') {
          await client.query(
            'UPDATE workflow_threads candidate SET is_primary = true ' +
            'WHERE candidate.id = (' +
              'SELECT remaining.id FROM workflow_threads remaining ' +
              'WHERE remaining.route_id = $1 ' +
              "AND remaining.status <> 'archived' " +
              'ORDER BY remaining.updated_at DESC, remaining.id LIMIT 1' +
            ') AND NOT EXISTS (' +
              'SELECT 1 FROM workflow_threads existing ' +
              'WHERE existing.route_id = $1 ' +
              "AND existing.status <> 'archived' AND existing.is_primary" +
            ')',
            [route.id],
          );
        }
        await client.query(
          'UPDATE contexts SET updated_at = $2 WHERE id = $1',
          [result.rows[0].context_id, input.now],
        );
        return mapConversation(result.rows[0]);
      });
    },

    async createThread(input: {
      userId: string;
      id: string;
      routeId: string;
      stageKey: string;
      title: string;
      now: Date;
    }): Promise<WorkflowThread | null> {
      return withTransaction(pool, async (client) => {
        const routeResult = await client.query<{ context_id: string }>(
          'SELECT r.context_id FROM workflow_routes r ' +
          'JOIN contexts c ON c.id = r.context_id ' +
          'WHERE r.id = $1 AND c.user_id = $2 FOR UPDATE OF r',
          [input.routeId, input.userId],
        );
        const route = routeResult.rows[0];
        if (!route) return null;
        const result = await client.query<ThreadRow>(
          'INSERT INTO workflow_threads ' +
          '(id, context_id, route_id, stage_key, title, title_source, is_primary, status, created_at, updated_at) ' +
          "VALUES ($1, $2, $3, $4, $5, 'user', " +
          "NOT EXISTS (SELECT 1 FROM workflow_threads existing WHERE existing.route_id = $3 AND existing.status <> 'archived'), " +
          "'active', $6, $6) RETURNING *",
          [input.id, route.context_id, input.routeId, input.stageKey, input.title, input.now],
        );
        if (!result.rows[0]) return null;
        await client.query(
          'UPDATE contexts SET updated_at = $2 WHERE id = $1',
          [result.rows[0].context_id, input.now],
        );
        return mapThread(result.rows[0]);
      });
    },

    async updateThread(input: {
      userId: string;
      threadId: string;
      title?: string;
      status?: ThreadStatus;
      now: Date;
    }): Promise<WorkflowThread | null> {
      return withTransaction(pool, async (client) => {
        const routeResult = await client.query<{ id: string; context_id: string }>(
          'SELECT r.id, r.context_id FROM workflow_routes r ' +
          'JOIN contexts c ON c.id = r.context_id ' +
          'JOIN workflow_threads t ON t.route_id = r.id AND t.context_id = r.context_id ' +
          'WHERE t.id = $1 AND c.user_id = $2 FOR UPDATE OF r',
          [input.threadId, input.userId],
        );
        const route = routeResult.rows[0];
        if (!route) return null;
        const result = await client.query<ThreadRow>(
          'UPDATE workflow_threads t SET title = COALESCE($2, t.title), ' +
          "title_source = CASE WHEN $2 IS NULL THEN t.title_source ELSE 'user' END, " +
          'status = COALESCE($3, t.status), ' +
          'is_primary = CASE ' +
            "WHEN $3 = 'archived' THEN false " +
            "WHEN $3 IS NOT NULL AND $3 <> 'archived' AND t.status = 'archived' THEN NOT EXISTS (" +
              'SELECT 1 FROM workflow_threads existing ' +
              'WHERE existing.route_id = $5 AND existing.id <> t.id ' +
              "AND existing.status <> 'archived' AND existing.is_primary" +
            ') ' +
            'ELSE t.is_primary ' +
          'END, updated_at = $4 ' +
          'WHERE t.id = $1 AND t.route_id = $5 AND t.context_id = $6 RETURNING t.*',
          [
            input.threadId,
            input.title ?? null,
            input.status ?? null,
            input.now,
            route.id,
            route.context_id,
          ],
        );
        if (!result.rows[0]) return null;
        if (input.status === 'archived') {
          await client.query(
            'UPDATE workflow_threads candidate SET is_primary = true ' +
            'WHERE candidate.id = (' +
              'SELECT remaining.id FROM workflow_threads remaining ' +
              'WHERE remaining.route_id = $1 ' +
              "AND remaining.status <> 'archived' " +
              'ORDER BY remaining.updated_at DESC, remaining.id LIMIT 1' +
            ') AND NOT EXISTS (' +
              'SELECT 1 FROM workflow_threads existing ' +
              'WHERE existing.route_id = $1 ' +
              "AND existing.status <> 'archived' AND existing.is_primary" +
            ')',
            [route.id],
          );
        }
        await client.query(
          'UPDATE contexts SET updated_at = $2 WHERE id = $1',
          [result.rows[0].context_id, input.now],
        );
        return mapThread(result.rows[0]);
      });
    },

    async branchRoute(input: {
      userId: string;
      contextId: string;
      sourceCheckpointId: string;
      routeId: string;
      routeName: string;
      checkpointId: string;
      now: Date;
    }) {
      return withTransaction(pool, async (client) => {
        const sourceResult = await client.query<CheckpointRow & { source_route_name: string }>(
          'SELECT cp.*, source_route.name AS source_route_name FROM workflow_checkpoints cp ' +
          'JOIN workflow_routes source_route ON source_route.id = cp.route_id ' +
          'JOIN contexts c ON c.id = cp.context_id ' +
          'WHERE cp.id = $1 AND cp.context_id = $2 AND c.user_id = $3 FOR UPDATE OF cp',
          [input.sourceCheckpointId, input.contextId, input.userId],
        );
        const source = sourceResult.rows[0];
        if (!source) return null;
        const sourceSnapshot = normalizeCheckpointSnapshot(source.snapshot);
        // Only explicit legacy compatibility stages enter the three-status
        // projection table. Canonical Workflow statuses remain snapshot-owned.
        const sourceStages = checkpointStages(sourceSnapshot);
        await client.query(
          'INSERT INTO workflow_routes ' +
          '(id, context_id, name, origin_checkpoint_id, created_at, updated_at) ' +
          'VALUES ($1, $2, $3, $4, $5, $5)',
          [input.routeId, input.contextId, input.routeName, source.id, input.now],
        );
        for (const [position, stage] of sourceStages.entries()) {
          await client.query(
            'INSERT INTO route_stage_projections ' +
            '(route_id, stage_key, position, status, internal_state, updated_at) ' +
            'VALUES ($1, $2, $3, $4, $5, $6)',
            [input.routeId, stage.stage_key, position, stage.status, stage.internal_state, input.now],
          );
        }
        const checkpointResult = await client.query<CheckpointRow>(
          'INSERT INTO workflow_checkpoints ' +
          '(id, context_id, route_id, version, stage_key, reason, snapshot, created_at) ' +
          "VALUES ($1, $2, $3, 0, $4, 'branch', $5, $6) RETURNING *",
          [input.checkpointId, input.contextId, input.routeId, source.stage_key, sourceSnapshot, input.now],
        );
        const routeResult = await client.query<RouteRow>(
          'UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1 RETURNING *',
          [input.routeId, input.checkpointId],
        );
        await client.query('UPDATE contexts SET updated_at = $2 WHERE id = $1', [input.contextId, input.now]);
        return {
          route: mapRoute({
            ...routeResult.rows[0]!,
            origin_route_id: source.route_id,
            origin_route_name: source.source_route_name,
            origin_version: source.version,
            origin_stage_key: source.stage_key,
          }),
          checkpoint: mapCheckpoint(checkpointResult.rows[0]!),
        };
      });
    },
  };
}

export type DomainRepository = ReturnType<typeof createDomainRepository>;
