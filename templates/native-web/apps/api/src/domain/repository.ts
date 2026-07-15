import type { DatabasePool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import type {
  CheckpointReason,
  CheckpointSnapshot,
  ContextStatus,
  RouteStageStatus,
  StageProjection,
  ThreadStatus,
  WorkflowCheckpoint,
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
  stage_key: string;
  reason: CheckpointReason;
  snapshot: CheckpointSnapshot;
  created_at: Date;
}

interface ThreadRow {
  id: string;
  context_id: string;
  route_id: string;
  stage_key: string;
  title: string;
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
    snapshot: row.snapshot,
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

function snapshotFromStages(stages: StageProjection[]): CheckpointSnapshot {
  return {
    stages: stages.map((stage) => ({
      stage_key: stage.stageKey,
      status: stage.status,
      internal_state: stage.internalState,
    })),
  };
}

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
            input.stages[0]!.stageKey,
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
        'WHERE id = $1 AND user_id = $2 LIMIT 1',
        [contextId, userId],
      );
      if (!contextResult.rows[0]) return null;
      const routesResult = await pool.query<RouteRow>(
        'SELECT * FROM workflow_routes WHERE context_id = $1 ORDER BY created_at, id',
        [contextId],
      );
      return {
        context: mapContext(contextResult.rows[0]),
        routes: routesResult.rows.map(mapRoute),
      };
    },

    async getRouteWorkspace(userId: string, routeId: string, stageKey: string) {
      const routeResult = await pool.query<RouteWorkspaceRow>(
        'SELECT r.*, c.title, c.status, c.created_at AS context_created_at, ' +
        'c.updated_at AS context_updated_at ' +
        'FROM workflow_routes r JOIN contexts c ON c.id = r.context_id ' +
        'WHERE r.id = $1 AND c.user_id = $2 LIMIT 1',
        [routeId, userId],
      );
      const row = routeResult.rows[0];
      if (!row) return null;
      const [stagesResult, checkpointsResult, threadsResult] = await Promise.all([
        pool.query<StageRow>(
          'SELECT stage_key, position, status, internal_state FROM route_stage_projections ' +
          'WHERE route_id = $1 ORDER BY position',
          [routeId],
        ),
        pool.query<CheckpointRow>(
          'SELECT * FROM workflow_checkpoints WHERE route_id = $1 ORDER BY version, created_at, id',
          [routeId],
        ),
        pool.query<ThreadRow>(
          'SELECT * FROM workflow_threads ' +
          "WHERE route_id = $1 AND stage_key = $2 AND status = 'active' " +
          'ORDER BY updated_at DESC, id',
          [routeId, stageKey],
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
        stages: stagesResult.rows.map(mapStage),
        checkpoints: checkpointsResult.rows.map(mapCheckpoint),
        threads: threadsResult.rows.map(mapThread),
      };
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
        const result = await client.query<ThreadRow>(
          'INSERT INTO workflow_threads ' +
          '(id, context_id, route_id, stage_key, title, created_at, updated_at) ' +
          'SELECT $1, r.context_id, r.id, $3, $4, $5, $5 ' +
          'FROM workflow_routes r JOIN contexts c ON c.id = r.context_id ' +
          'WHERE r.id = $2 AND c.user_id = $6 RETURNING *',
          [input.id, input.routeId, input.stageKey, input.title, input.now, input.userId],
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
        const result = await client.query<ThreadRow>(
          'UPDATE workflow_threads t SET title = COALESCE($2, t.title), ' +
          'status = COALESCE($3, t.status), updated_at = $4 ' +
          'WHERE t.id = $1 AND EXISTS (' +
            'SELECT 1 FROM contexts c WHERE c.id = t.context_id AND c.user_id = $5' +
          ') RETURNING t.*',
          [input.threadId, input.title ?? null, input.status ?? null, input.now, input.userId],
        );
        if (!result.rows[0]) return null;
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
        const sourceResult = await client.query<CheckpointRow>(
          'SELECT cp.* FROM workflow_checkpoints cp ' +
          'JOIN contexts c ON c.id = cp.context_id ' +
          'WHERE cp.id = $1 AND cp.context_id = $2 AND c.user_id = $3 FOR UPDATE OF cp',
          [input.sourceCheckpointId, input.contextId, input.userId],
        );
        const source = sourceResult.rows[0];
        if (!source) return null;
        await client.query(
          'INSERT INTO workflow_routes ' +
          '(id, context_id, name, origin_checkpoint_id, created_at, updated_at) ' +
          'VALUES ($1, $2, $3, $4, $5, $5)',
          [input.routeId, input.contextId, input.routeName, source.id, input.now],
        );
        for (const [position, stage] of source.snapshot.stages.entries()) {
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
          [input.checkpointId, input.contextId, input.routeId, source.stage_key, source.snapshot, input.now],
        );
        const routeResult = await client.query<RouteRow>(
          'UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1 RETURNING *',
          [input.routeId, input.checkpointId],
        );
        await client.query('UPDATE contexts SET updated_at = $2 WHERE id = $1', [input.contextId, input.now]);
        return {
          route: mapRoute(routeResult.rows[0]!),
          checkpoint: mapCheckpoint(checkpointResult.rows[0]!),
        };
      });
    },
  };
}

export type DomainRepository = ReturnType<typeof createDomainRepository>;
