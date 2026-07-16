import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';

function mapProposal(row: Record<string, any>) {
  return {
    id: row.id,
    commandId: row.command_id,
    contextId: row.context_id,
    routeId: row.route_id,
    threadId: row.thread_id,
    stageKey: row.stage_key,
    scope: row.scope,
    key: row.proposal_key,
    value: row.proposal_value,
    status: row.status,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

export function createMemoryRepository(pool: DatabasePool) {
  async function list(userId: string, threadId?: string) {
    const result = await pool.query(
      'SELECT * FROM memory_proposals WHERE user_id = $1 ' +
      (threadId ? 'AND thread_id = $2 ' : '') +
      'ORDER BY created_at DESC, id',
      threadId ? [userId, threadId] : [userId],
    );
    return result.rows.map(mapProposal);
  }

  async function decide(userId: string, proposalId: string, decision: 'adopted' | 'rejected', now: Date) {
    return withTransaction(pool, async (client) => {
      const result = await client.query(
        'SELECT * FROM memory_proposals WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [proposalId, userId],
      );
      const proposal = result.rows[0];
      if (!proposal) return null;
      if (proposal.status !== 'pending') return { proposal: mapProposal(proposal), alreadyDecided: true };
      const updated = await client.query(
        'UPDATE memory_proposals SET status = $3, decided_at = $4 WHERE id = $1 AND user_id = $2 RETURNING *',
        [proposalId, userId, decision, now],
      );
      if (decision === 'adopted') {
        const scoped = {
          context: proposal.scope === 'user' ? null : proposal.context_id,
          route: ['route', 'stage', 'thread'].includes(proposal.scope) ? proposal.route_id : null,
          thread: proposal.scope === 'thread' ? proposal.thread_id : null,
          stage: ['stage', 'thread'].includes(proposal.scope) ? proposal.stage_key : null,
        };
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          [userId, proposal.scope, scoped.context, scoped.route, scoped.thread, scoped.stage, proposal.proposal_key].join('|'),
        ]);
        await client.query(
          'INSERT INTO memory_entries ' +
          '(id,user_id,proposal_id,scope,context_id,route_id,thread_id,stage_key,entry_key,entry_value,version) ' +
          'SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE(MAX(version),0)+1 FROM memory_entries ' +
          'WHERE user_id=$2 AND scope=$4 AND context_id IS NOT DISTINCT FROM $5 AND route_id IS NOT DISTINCT FROM $6 ' +
          'AND thread_id IS NOT DISTINCT FROM $7 AND stage_key IS NOT DISTINCT FROM $8 AND entry_key=$9',
          [randomUUID(), userId, proposal.id, proposal.scope, scoped.context, scoped.route, scoped.thread, scoped.stage,
            proposal.proposal_key, JSON.stringify(proposal.proposal_value)],
        );
      }
      return { proposal: mapProposal(updated.rows[0]), alreadyDecided: false };
    });
  }

  return { list, decide };
}

export type MemoryRepository = ReturnType<typeof createMemoryRepository>;
