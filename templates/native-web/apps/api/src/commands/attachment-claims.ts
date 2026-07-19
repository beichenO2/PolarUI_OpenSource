import type { DatabaseClient } from '../db/pool.js';

interface ClaimCommandRow {
  id: string;
  context_id: string;
  status: string;
  lease_expires_at: Date | null;
}

const CLEANUP_SAVEPOINT = 'staged_attachment_claim_cleanup';

export async function releaseClaimedStagedAttachments(
  client: DatabaseClient,
  commandId: string,
  contextId: string,
  now: Date,
) {
  await client.query(
    "UPDATE staged_attachments SET claimed_command_id = NULL, claimed_context_id = NULL, updated_at = $3 " +
    "WHERE claimed_command_id = $1 AND claimed_context_id = $2 AND status = 'pending'",
    [commandId, contextId, now],
  );
}

async function claimedCommandIds(
  client: DatabaseClient,
  userId: string,
  attachmentIds: string[],
) {
  const result = await client.query<{ claimed_command_id: string }>(
    'SELECT DISTINCT claimed_command_id FROM staged_attachments ' +
    'WHERE id = ANY($1::uuid[]) AND user_id = $2 AND claimed_command_id IS NOT NULL ' +
    'ORDER BY claimed_command_id',
    [attachmentIds, userId],
  );
  return result.rows.map((row) => row.claimed_command_id);
}

async function appendTerminalEvent(
  client: DatabaseClient,
  commandId: string,
  errorCode: string,
  now: Date,
) {
  await client.query(
    'INSERT INTO workflow_command_events (command_id, sequence, event_type, payload, created_at) ' +
    "SELECT $1, COALESCE(MAX(sequence), 0) + 1, 'command.finished', $2, $3 " +
    'FROM workflow_command_events WHERE command_id = $1',
    [commandId, { outcome: 'failed', code: errorCode }, now],
  );
}

/**
 * Resolve claims only after locking their owning Commands. Command finalization
 * uses the same command-before-attachment order, so a late successful finalize
 * either wins in full or observes the durable terminal state written here.
 */
export async function expireStaleAttachmentClaims(
  client: DatabaseClient,
  userId: string,
  attachmentIds: string[],
  now: Date,
) {
  if (attachmentIds.length === 0) return;

  while (true) {
    await client.query(`SAVEPOINT ${CLEANUP_SAVEPOINT}`);
    try {
      const discoveredIds = await claimedCommandIds(client, userId, attachmentIds);
      if (discoveredIds.length === 0) {
        await client.query(`RELEASE SAVEPOINT ${CLEANUP_SAVEPOINT}`);
        return;
      }

      const commands = await client.query<ClaimCommandRow>(
        'SELECT id, context_id, status, lease_expires_at FROM workflow_commands ' +
        'WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [discoveredIds],
      );
      const locked = new Map(commands.rows.map((command) => [command.id, command]));
      const currentIds = await claimedCommandIds(client, userId, attachmentIds);
      if (currentIds.some((commandId) => !locked.has(commandId))) {
        await client.query(`ROLLBACK TO SAVEPOINT ${CLEANUP_SAVEPOINT}`);
        await client.query(`RELEASE SAVEPOINT ${CLEANUP_SAVEPOINT}`);
        continue;
      }

      for (const commandId of currentIds) {
        const command = locked.get(commandId);
        if (!command) continue;
        if (command.status === 'succeeded' || command.status === 'failed' || command.status === 'conflict') {
          await releaseClaimedStagedAttachments(client, command.id, command.context_id, now);
          continue;
        }
        if (!command.lease_expires_at || command.lease_expires_at > now) continue;

        const started = await client.query<{ exists: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM workflow_command_events " +
          "WHERE command_id = $1 AND event_type = 'workflow.started') AS exists",
          [command.id],
        );
        const errorCode = started.rows[0]!.exists
          ? 'WORKFLOW_OUTCOME_UNKNOWN'
          : 'COMMAND_LEASE_EXPIRED';
        await client.query(
          "UPDATE workflow_commands SET status = 'failed', lease_expires_at = NULL, error_code = $2, " +
          "updated_at = $3 WHERE id = $1 AND status IN ('pending', 'running')",
          [command.id, errorCode, now],
        );
        await appendTerminalEvent(client, command.id, errorCode, now);
        await releaseClaimedStagedAttachments(client, command.id, command.context_id, now);
      }

      await client.query(`RELEASE SAVEPOINT ${CLEANUP_SAVEPOINT}`);
      return;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${CLEANUP_SAVEPOINT}`);
      await client.query(`RELEASE SAVEPOINT ${CLEANUP_SAVEPOINT}`);
      throw error;
    }
  }
}
