import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, withTransaction } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const pools: Array<ReturnType<typeof createPool>> = [];
const adminPool = databaseUrl ? createPool(databaseUrl) : null;
const schemaName = 'migrate_integration';

function isolatedDatabaseUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.set('options', '-csearch_path=' + schemaName);
  return url.toString();
}

async function freshPool() {
  await adminPool!.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
  await adminPool!.query('CREATE SCHEMA ' + schemaName);
  const pool = createPool(isolatedDatabaseUrl(databaseUrl!));
  pools.push(pool);
  return pool;
}

async function runLegacyMigrations(pool: ReturnType<typeof createPool>) {
  const directory = await mkdtemp(join(tmpdir(), 'polar-native-legacy-migrations-'));
  try {
    await Promise.all([
      '0001_identity.sql',
      '0002_workflow_domain.sql',
      '0003_workflow_commands.sql',
      '0004_assets_memory_archive.sql',
    ].map((fileName) => copyFile(
      join(migrationsDir, fileName),
      join(directory, fileName),
    )));
    await runMigrations({ pool, migrationsDir: directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createWorkflowFixture(pool: ReturnType<typeof createPool>) {
  const ids = {
    user: randomUUID(),
    context: randomUUID(),
    route: randomUUID(),
    checkpoint: randomUUID(),
    thread: randomUUID(),
  };
  const identity = ids.user.replaceAll('-', '');
  await pool.query(
    'INSERT INTO users (id, email, email_normalized, username, username_normalized, password_hash, email_verified_at, status, created_via) ' +
      "VALUES ($1, $2, $2, $3, $3, 'hash', now(), 'active', 'admin_cli')",
    [ids.user, `${identity}@example.test`, `user_${identity}`],
  );
  await pool.query(
    'INSERT INTO contexts (id, user_id, title) VALUES ($1, $2, $3)',
    [ids.context, ids.user, 'Context'],
  );
  await withTransaction(pool, async (client) => {
    await client.query(
      'INSERT INTO workflow_routes (id, context_id, name) VALUES ($1, $2, $3)',
      [ids.route, ids.context, 'Main'],
    );
    await client.query(
      "INSERT INTO workflow_checkpoints (id, context_id, route_id, version, stage_key, reason, snapshot) VALUES ($1, $2, $3, 0, 'work', 'bootstrap', '{\"stages\":[]}'::jsonb)",
      [ids.checkpoint, ids.context, ids.route],
    );
    await client.query(
      'UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1',
      [ids.route, ids.checkpoint],
    );
  });
  await pool.query(
    "INSERT INTO route_stage_projections (route_id, stage_key, position, status, internal_state) VALUES ($1, 'work', 0, 'active', 'running')",
    [ids.route],
  );
  await pool.query(
    "INSERT INTO workflow_threads (id, context_id, route_id, stage_key, title) VALUES ($1, $2, $3, 'work', 'Thread')",
    [ids.thread, ids.context, ids.route],
  );
  return ids;
}

async function insertCommand(
  pool: ReturnType<typeof createPool>,
  ids: Awaited<ReturnType<typeof createWorkflowFixture>>,
  overrides: {
    id?: string;
    kind?: 'message' | 'named_action' | 'resume_interrupt';
    actionKey?: string | null;
    interruptId?: string | null;
    inputHash?: string;
  } = {},
) {
  const commandId = overrides.id ?? randomUUID();
  const kind = overrides.kind ?? 'message';
  await pool.query(
    'INSERT INTO workflow_commands ' +
      '(id, context_id, source_route_id, source_thread_id, stage_key, base_checkpoint_id, expected_checkpoint_version, kind, action_key, interrupt_id, content, input_hash, status) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10, $11, $12)',
    [
      commandId,
      ids.context,
      ids.route,
      ids.thread,
      'work',
      ids.checkpoint,
      kind,
      overrides.actionKey ?? null,
      overrides.interruptId ?? null,
      kind === 'named_action' ? 'Adopt result' : 'Hello',
      overrides.inputHash ?? `sha256:${commandId}`,
      'pending',
    ],
  );
  return commandId;
}

afterAll(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  await adminPool?.end();
});

integrationDescribe('identity migrations', () => {
  let pool: ReturnType<typeof createPool>;

  beforeEach(async () => {
    pool = await freshPool();
  });

  it('applies the identity migration once and records its checksum', async () => {
    await runMigrations({ pool, migrationsDir });
    await runMigrations({ pool, migrationsDir });

    const applied = await pool.query(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    expect(applied.rows.at(-1)).toMatchObject({
      version: '0005_core_input_memory',
    });
    expect(applied.rows).toEqual([
      expect.objectContaining({
        version: '0001_identity',
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: '0002_workflow_domain',
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: '0003_workflow_commands',
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: '0004_assets_memory_archive',
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        version: '0005_core_input_memory',
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);

    const tables = await pool.query<{ table_name: string }>(
      'SELECT table_name ' +
        'FROM information_schema.tables ' +
        'WHERE table_schema = $2 ' +
        'AND table_name = ANY($1::text[]) ' +
        'ORDER BY table_name',
      [[
        'auth_sessions',
        'asset_objects',
        'contexts',
        'email_verifications',
        'librechat_archive_attachments',
        'librechat_archive_conversations',
        'librechat_archive_messages',
        'memory_entries',
        'memory_item_versions',
        'memory_items',
        'memory_proposals',
        'route_stage_projections',
        'staged_attachments',
        'users',
        'workflow_artifacts',
        'workflow_attachments',
        'workflow_checkpoints',
        'workflow_command_events',
        'workflow_commands',
        'workflow_interrupts',
        'workflow_messages',
        'workflow_routes',
        'workflow_threads',
      ], schemaName],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'asset_objects',
      'auth_sessions',
      'contexts',
      'email_verifications',
      'librechat_archive_attachments',
      'librechat_archive_conversations',
      'librechat_archive_messages',
      'memory_entries',
      'memory_item_versions',
      'memory_items',
      'memory_proposals',
      'route_stage_projections',
      'staged_attachments',
      'users',
      'workflow_artifacts',
      'workflow_attachments',
      'workflow_checkpoints',
      'workflow_command_events',
      'workflow_commands',
      'workflow_interrupts',
      'workflow_messages',
      'workflow_routes',
      'workflow_threads',
    ]);

    const originColumn = await pool.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'workflow_threads' AND column_name = 'origin_thread_id'",
      [schemaName],
    );
    expect(originColumn.rows).toEqual([{ is_nullable: 'YES' }]);
  });

  it('migrates complete legacy causal rows and supports an initializing zero-Stage flow', async () => {
    await runLegacyMigrations(pool);
    const legacy = await createWorkflowFixture(pool);
    const legacyCommandId = await insertCommand(pool, legacy);
    const legacyObjectId = randomUUID();
    const legacyMessageId = randomUUID();
    const legacyAttachmentId = randomUUID();
    const legacyArtifactId = randomUUID();
    const legacyProposalId = randomUUID();
    const legacyInterruptId = randomUUID();

    await pool.query(
      'INSERT INTO asset_objects ' +
        '(id, user_id, storage_key, sha256, byte_size, media_type, status) ' +
        "VALUES ($1, $2, $3, $4, 4, 'text/plain', 'ready')",
      [
        legacyObjectId,
        legacy.user,
        `objects/legacy/${legacyObjectId}`,
        'c'.repeat(64),
      ],
    );
    await pool.query(
      'INSERT INTO workflow_messages ' +
        '(id, command_id, context_id, route_id, thread_id, stage_key, role, content, sequence) ' +
        "VALUES ($1, $2, $3, $4, $5, 'work', 'user', 'Legacy message', 1)",
      [
        legacyMessageId,
        legacyCommandId,
        legacy.context,
        legacy.route,
        legacy.thread,
      ],
    );
    await pool.query(
      'INSERT INTO workflow_attachments ' +
        '(id, user_id, object_id, context_id, route_id, thread_id, stage_key, filename) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, 'work', 'legacy-input.txt')",
      [
        legacyAttachmentId,
        legacy.user,
        legacyObjectId,
        legacy.context,
        legacy.route,
        legacy.thread,
      ],
    );
    await pool.query(
      'INSERT INTO workflow_artifacts ' +
        '(id, user_id, object_id, command_id, context_id, route_id, thread_id, stage_key, filename, status) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, 'work', 'legacy-output.txt', 'ready')",
      [
        legacyArtifactId,
        legacy.user,
        legacyObjectId,
        legacyCommandId,
        legacy.context,
        legacy.route,
        legacy.thread,
      ],
    );

    await pool.query(
      'INSERT INTO memory_proposals ' +
        '(id, user_id, command_id, context_id, route_id, thread_id, stage_key, scope, proposal_key, proposal_value, status) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, 'work', 'route', 'legacy-key', $7::jsonb, 'pending')",
      [
        legacyProposalId,
        legacy.user,
        legacyCommandId,
        legacy.context,
        legacy.route,
        legacy.thread,
        JSON.stringify('legacy-value'),
      ],
    );
    await pool.query(
      'INSERT INTO workflow_interrupts ' +
        '(id, context_id, route_id, thread_id, stage_key, prompt, workflow_cursor, originating_command_id, status) ' +
        "VALUES ($1, $2, $3, $4, 'work', 'Legacy prompt', " +
        `'{"cursor":1}'::jsonb, $5, 'pending')`,
      [
        legacyInterruptId,
        legacy.context,
        legacy.route,
        legacy.thread,
        legacyCommandId,
      ],
    );
    const legacyResolutionCommandId = await insertCommand(pool, legacy, {
      kind: 'resume_interrupt',
      interruptId: legacyInterruptId,
    });
    await pool.query(
      "UPDATE workflow_interrupts SET status = 'resolved', " +
        'resolution_command_id = $2, resolved_at = now(), updated_at = now() ' +
        'WHERE id = $1',
      [legacyInterruptId, legacyResolutionCommandId],
    );

    await runMigrations({ pool, migrationsDir });

    const [
      legacyContext,
      legacyRoute,
      legacyConversation,
      legacyCommand,
      legacyProposal,
      legacySurvivors,
      nullableStageColumns,
    ] = await Promise.all([
      pool.query(
        'SELECT id, title_source, status FROM contexts WHERE id = $1',
        [legacy.context],
      ),
      pool.query(
        'SELECT id, status FROM workflow_routes WHERE id = $1',
        [legacy.route],
      ),
      pool.query(
        'SELECT id, title_source, is_primary, status, stage_key ' +
          'FROM workflow_threads WHERE id = $1',
        [legacy.thread],
      ),
      pool.query(
        'SELECT id, stage_key FROM workflow_commands WHERE id = $1',
        [legacyCommandId],
      ),
      pool.query('SELECT id FROM memory_proposals WHERE id = $1', [legacyProposalId]),
      pool.query(
        'SELECT ' +
          'EXISTS (SELECT 1 FROM asset_objects WHERE id = $1) AS object_survived, ' +
          'EXISTS (SELECT 1 FROM workflow_messages WHERE id = $2) AS message_survived, ' +
          'EXISTS (SELECT 1 FROM workflow_attachments WHERE id = $3) AS attachment_survived, ' +
          'EXISTS (SELECT 1 FROM workflow_artifacts WHERE id = $4) AS artifact_survived, ' +
          'EXISTS (SELECT 1 FROM workflow_commands WHERE id = $5) AS resolution_command_survived, ' +
          'EXISTS (' +
            'SELECT 1 FROM workflow_interrupts ' +
            "WHERE id = $6 AND status = 'resolved' " +
            'AND originating_command_id = $7 AND resolution_command_id = $5' +
          ') AS interrupt_cycle_survived',
        [
          legacyObjectId,
          legacyMessageId,
          legacyAttachmentId,
          legacyArtifactId,
          legacyResolutionCommandId,
          legacyInterruptId,
          legacyCommandId,
        ],
      ),
      pool.query(
        'SELECT table_name, column_name, is_nullable ' +
          'FROM information_schema.columns ' +
          'WHERE table_schema = $1 ' +
          "AND table_name = ANY($2::text[]) AND column_name = 'stage_key' " +
          'ORDER BY table_name',
        [schemaName, [
          'memory_proposals',
          'workflow_artifacts',
          'workflow_attachments',
          'workflow_checkpoints',
          'workflow_commands',
          'workflow_interrupts',
          'workflow_messages',
          'workflow_threads',
        ]],
      ),
    ]);
    expect(legacyContext.rows).toEqual([{
      id: legacy.context,
      title_source: 'user',
      status: 'active',
    }]);
    expect(legacyRoute.rows).toEqual([{
      id: legacy.route,
      status: 'active',
    }]);
    expect(legacyConversation.rows).toEqual([{
      id: legacy.thread,
      title_source: 'user',
      is_primary: true,
      status: 'active',
      stage_key: 'work',
    }]);
    expect(legacyCommand.rows).toEqual([{
      id: legacyCommandId,
      stage_key: 'work',
    }]);
    expect(legacyProposal.rows).toEqual([{ id: legacyProposalId }]);
    expect(legacySurvivors.rows).toEqual([{
      object_survived: true,
      message_survived: true,
      attachment_survived: true,
      artifact_survived: true,
      resolution_command_survived: true,
      interrupt_cycle_survived: true,
    }]);
    expect(nullableStageColumns.rows).toEqual([
      {
        table_name: 'memory_proposals',
        column_name: 'stage_key',
        is_nullable: 'YES',
      },
      {
        table_name: 'workflow_artifacts',
        column_name: 'stage_key',
        is_nullable: 'YES',
      },
      {
        table_name: 'workflow_attachments',
        column_name: 'stage_key',
        is_nullable: 'YES',
      },
      {
        table_name: 'workflow_checkpoints',
        column_name: 'stage_key',
        is_nullable: 'YES',
      },
      {
        table_name: 'workflow_commands',
        column_name: 'stage_key',
        is_nullable: 'YES',
      },
      {
        table_name: 'workflow_interrupts',
        column_name: 'stage_key',
        is_nullable: 'YES',
      },
      {
        table_name: 'workflow_messages',
        column_name: 'stage_key',
        is_nullable: 'YES',
      },
      {
        table_name: 'workflow_threads',
        column_name: 'stage_key',
        is_nullable: 'YES',
      },
    ]);

    const next = {
      context: randomUUID(),
      route: randomUUID(),
      checkpoint: randomUUID(),
      conversation: randomUUID(),
      command: randomUUID(),
    };
    await pool.query(
      'INSERT INTO contexts (id, user_id, title, title_source, status) ' +
        "VALUES ($1, $2, 'Initializing context', 'agent', 'initializing')",
      [next.context, legacy.user],
    );
    await withTransaction(pool, async (client) => {
      await client.query(
        'INSERT INTO workflow_routes (id, context_id, name, status) ' +
          "VALUES ($1, $2, 'Initializing route', 'initializing')",
        [next.route, next.context],
      );
      await client.query(
        'INSERT INTO workflow_checkpoints ' +
          '(id, context_id, route_id, version, stage_key, reason, snapshot) ' +
          "VALUES ($1, $2, $3, 0, NULL, 'bootstrap', " +
          `'{"workflowState":{},"memoryReferences":[],"artifacts":[]}'::jsonb)`,
        [next.checkpoint, next.context, next.route],
      );
      await client.query(
        'UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1',
        [next.route, next.checkpoint],
      );
    });
    await pool.query(
      'INSERT INTO workflow_threads ' +
        '(id, context_id, route_id, stage_key, title, title_source, is_primary, status) ' +
        "VALUES ($1, $2, $3, NULL, 'New conversation', 'agent', true, 'initializing')",
      [next.conversation, next.context, next.route],
    );
    await pool.query(
      'INSERT INTO workflow_commands ' +
        '(id, context_id, source_route_id, source_thread_id, stage_key, base_checkpoint_id, ' +
        'expected_checkpoint_version, kind, content, input_hash, status) ' +
        "VALUES ($1, $2, $3, $4, NULL, $5, 0, 'message', 'Hello', $6, 'pending')",
      [
        next.command,
        next.context,
        next.route,
        next.conversation,
        next.checkpoint,
        `sha256:${next.command}`,
      ],
    );

    const publicRows = await pool.query(
      'SELECT c.status AS context_status, c.title_source AS context_title_source, ' +
        'r.status AS route_status, cp.stage_key AS checkpoint_stage_key, ' +
        't.stage_key AS conversation_stage_key, t.is_primary AS conversation_is_primary, ' +
        't.title_source AS conversation_title_source, t.status AS conversation_status, ' +
        'cmd.stage_key AS command_stage_key, ' +
        '(SELECT count(*)::int FROM route_stage_projections projection ' +
          'WHERE projection.route_id = r.id) AS stage_projection_count ' +
        'FROM contexts c ' +
        'JOIN workflow_routes r ON r.context_id = c.id ' +
        'JOIN workflow_checkpoints cp ON cp.id = r.head_checkpoint_id ' +
        'JOIN workflow_threads t ON t.route_id = r.id ' +
        'JOIN workflow_commands cmd ON cmd.source_thread_id = t.id ' +
        'WHERE cmd.id = $1',
      [next.command],
    );
    expect(publicRows.rows).toEqual([{
      context_status: 'initializing',
      context_title_source: 'agent',
      route_status: 'initializing',
      checkpoint_stage_key: null,
      conversation_stage_key: null,
      conversation_is_primary: true,
      conversation_title_source: 'agent',
      conversation_status: 'initializing',
      command_stage_key: null,
      stage_projection_count: 0,
    }]);
  });

  it('backfills the newest non-archived legacy Thread as the deterministic Route primary', async () => {
    await runLegacyMigrations(pool);
    const legacy = await createWorkflowFixture(pool);
    const newestThreadId = randomUUID();
    const oldestUpdatedAt = new Date('2026-07-17T10:00:00.000Z');
    const newestUpdatedAt = new Date('2026-07-17T11:00:00.000Z');

    await pool.query(
      'UPDATE workflow_threads SET created_at = $2, updated_at = $2 WHERE id = $1',
      [legacy.thread, oldestUpdatedAt],
    );
    await pool.query(
      'INSERT INTO workflow_threads ' +
        '(id, context_id, route_id, stage_key, title, status, created_at, updated_at) ' +
        "VALUES ($1, $2, $3, 'work', 'Newer legacy Thread', 'active', $4, $4)",
      [newestThreadId, legacy.context, legacy.route, newestUpdatedAt],
    );

    await runMigrations({ pool, migrationsDir });

    expect((await pool.query(
      'SELECT id, title_source, status, is_primary, updated_at ' +
        'FROM workflow_threads WHERE route_id = $1 ORDER BY updated_at DESC, id',
      [legacy.route],
    )).rows).toEqual([
      {
        id: newestThreadId,
        title_source: 'user',
        status: 'active',
        is_primary: true,
        updated_at: newestUpdatedAt,
      },
      {
        id: legacy.thread,
        title_source: 'user',
        status: 'active',
        is_primary: false,
        updated_at: oldestUpdatedAt,
      },
    ]);
  });

  it('enforces public memory scopes, immutable identity, and sequential version pointers', async () => {
    await runMigrations({ pool, migrationsDir });
    const ids = await createWorkflowFixture(pool);
    const other = await createWorkflowFixture(pool);
    const siblingContextId = randomUUID();
    await pool.query(
      'INSERT INTO contexts (id, user_id, title) VALUES ($1, $2, $3)',
      [siblingContextId, ids.user, 'Sibling context'],
    );

    async function insertMemory(scope: 'user' | 'context' | 'route') {
      const memoryId = randomUUID();
      return withTransaction(pool, async (client) => {
        await client.query(
          'INSERT INTO memory_items ' +
            '(id, user_id, scope, context_id, memory_key, status, current_version) ' +
            "VALUES ($1, $2, $3, $4, $5, 'active', 1)",
          [
            memoryId,
            ids.user,
            scope,
            scope === 'user' ? null : ids.context,
            `${scope}-memory`,
          ],
        );
        await client.query(
          'INSERT INTO memory_item_versions ' +
            '(id, memory_id, version, value, status, source, evidence, impact_scope) ' +
            "VALUES ($1, $2, 1, $3::jsonb, 'active', $4::jsonb, $5::jsonb, $6::jsonb)",
          [
            randomUUID(),
            memoryId,
            JSON.stringify({ text: `${scope} value` }),
            JSON.stringify({ kind: 'workflow' }),
            JSON.stringify([]),
            JSON.stringify({ contextIds: scope === 'user' ? 'all' : [ids.context] }),
          ],
        );
        return memoryId;
      });
    }

    const userMemoryId = await insertMemory('user');
    const contextMemoryId = await insertMemory('context');
    await expect(insertMemory('route')).rejects.toMatchObject({ code: '23514' });

    const memories = await pool.query(
      'SELECT id, scope, context_id, current_version, status ' +
        'FROM memory_items WHERE id = ANY($1::uuid[]) ORDER BY scope DESC',
      [[userMemoryId, contextMemoryId]],
    );
    expect(memories.rows).toEqual([
      {
        id: userMemoryId,
        scope: 'user',
        context_id: null,
        current_version: 1,
        status: 'active',
      },
      {
        id: contextMemoryId,
        scope: 'context',
        context_id: ids.context,
        current_version: 1,
        status: 'active',
      },
    ]);

    await expect(pool.query(
      'UPDATE memory_items SET current_version = 2 WHERE id = $1',
      [userMemoryId],
    )).rejects.toMatchObject({ code: '23503' });

    await withTransaction(pool, async (client) => {
      await client.query(
        'INSERT INTO memory_item_versions ' +
          '(id, memory_id, version, value, status, source, evidence, impact_scope) ' +
          "VALUES ($1, $2, 2, NULL, 'invalidated', $3::jsonb, $4::jsonb, $5::jsonb)",
        [
          randomUUID(),
          userMemoryId,
          JSON.stringify({ kind: 'user', reason: 'removed' }),
          JSON.stringify([{ kind: 'user_action', id: 'invalidate' }]),
          JSON.stringify({ contextIds: 'all' }),
        ],
      );
      await client.query(
        "UPDATE memory_items SET current_version = 2, status = 'invalidated', " +
          'updated_at = $2 WHERE id = $1',
        [userMemoryId, new Date('2026-07-17T12:00:00.000Z')],
      );
    });

    const versionHistory = await pool.query(
      'SELECT version, value, status FROM memory_item_versions ' +
        'WHERE memory_id = $1 ORDER BY version',
      [userMemoryId],
    );
    expect(versionHistory.rows).toEqual([
      {
        version: 1,
        value: { text: 'user value' },
        status: 'active',
      },
      {
        version: 2,
        value: null,
        status: 'invalidated',
      },
    ]);
    const currentMemory = await pool.query(
      'SELECT current_version, status FROM memory_items WHERE id = $1',
      [userMemoryId],
    );
    expect(currentMemory.rows).toEqual([{
      current_version: 2,
      status: 'invalidated',
    }]);

    await expect(pool.query(
      "UPDATE memory_items SET current_version = 1, status = 'active' WHERE id = $1",
      [userMemoryId],
    )).rejects.toMatchObject({ code: '55000' });

    for (const version of [2, 3]) {
      await pool.query(
        'INSERT INTO memory_item_versions ' +
          '(id, memory_id, version, value, status, source, evidence, impact_scope) ' +
          "VALUES ($1, $2, $3, $4::jsonb, 'active', $5::jsonb, $6::jsonb, $7::jsonb)",
        [
          randomUUID(),
          contextMemoryId,
          version,
          JSON.stringify({ text: `context value ${version}` }),
          JSON.stringify({ kind: 'workflow', version }),
          JSON.stringify([]),
          JSON.stringify({ contextIds: [ids.context] }),
        ],
      );
    }
    await expect(pool.query(
      'UPDATE memory_items SET current_version = 3 WHERE id = $1',
      [contextMemoryId],
    )).rejects.toMatchObject({ code: '55000' });

    await expect(pool.query(
      'UPDATE memory_items SET user_id = $2 WHERE id = $1',
      [userMemoryId, other.user],
    )).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query(
      "UPDATE memory_items SET scope = 'context', context_id = $2 WHERE id = $1",
      [userMemoryId, ids.context],
    )).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query(
      'UPDATE memory_items SET context_id = $2 WHERE id = $1',
      [contextMemoryId, siblingContextId],
    )).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query(
      "UPDATE memory_items SET memory_key = 'renamed-memory' WHERE id = $1",
      [userMemoryId],
    )).rejects.toMatchObject({ code: '55000' });

    await expect(pool.query(
      "UPDATE memory_item_versions SET value = '\"changed\"'::jsonb " +
        'WHERE memory_id = $1 AND version = 1',
      [userMemoryId],
    )).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query(
      'DELETE FROM memory_item_versions WHERE memory_id = $1 AND version = 1',
      [userMemoryId],
    )).rejects.toMatchObject({ code: '55000' });
  });

  it('binds artifact and memory-proposal command causality to Context, Route, and Conversation', async () => {
    await runMigrations({ pool, migrationsDir });
    const first = await createWorkflowFixture(pool);
    const second = await createWorkflowFixture(pool);
    const firstCommandId = await insertCommand(pool, first);
    const secondCommandId = await insertCommand(pool, second);
    const alternate = {
      ...first,
      route: randomUUID(),
      checkpoint: randomUUID(),
      thread: randomUUID(),
    };

    await withTransaction(pool, async (client) => {
      await client.query(
        'INSERT INTO workflow_routes (id, context_id, name) VALUES ($1, $2, $3)',
        [alternate.route, first.context, 'Alternate'],
      );
      await client.query(
        'INSERT INTO workflow_checkpoints ' +
          '(id, context_id, route_id, version, stage_key, reason, snapshot) ' +
          "VALUES ($1, $2, $3, 0, 'work', 'bootstrap', " +
          `'{"workflowState":{},"memoryReferences":[],"artifacts":[]}'::jsonb)`,
        [alternate.checkpoint, first.context, alternate.route],
      );
      await client.query(
        'UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1',
        [alternate.route, alternate.checkpoint],
      );
    });
    await pool.query(
      'INSERT INTO route_stage_projections ' +
        '(route_id, stage_key, position, status, internal_state) ' +
        "VALUES ($1, 'work', 0, 'active', 'running')",
      [alternate.route],
    );
    await pool.query(
      'INSERT INTO workflow_threads (id, context_id, route_id, stage_key, title) ' +
        "VALUES ($1, $2, $3, 'work', 'Alternate conversation')",
      [alternate.thread, first.context, alternate.route],
    );
    const alternateCommandId = await insertCommand(pool, alternate);

    async function insertArtifact(
      commandId: string,
      marker: string,
      scope = first,
    ) {
      return pool.query(
        'INSERT INTO workflow_artifacts ' +
          '(id, user_id, command_id, context_id, route_id, thread_id, stage_key, filename, status) ' +
          "VALUES ($1, $2, $3, $4, $5, $6, 'work', $7, 'pending')",
        [
          randomUUID(),
          first.user,
          commandId,
          first.context,
          scope.route,
          scope.thread,
          `${marker}.txt`,
        ],
      );
    }

    async function insertProposal(
      commandId: string,
      marker: string,
      scope = first,
    ) {
      return pool.query(
        'INSERT INTO memory_proposals ' +
          '(id, user_id, command_id, context_id, route_id, thread_id, stage_key, ' +
          'scope, proposal_key, proposal_value, status) ' +
          "VALUES ($1, $2, $3, $4, $5, $6, 'work', 'context', $7, " +
          `'"value"'::jsonb, 'pending')`,
        [
          randomUUID(),
          first.user,
          commandId,
          first.context,
          scope.route,
          scope.thread,
          marker,
        ],
      );
    }

    async function insertMessage(
      commandId: string,
      marker: string,
      role: 'user' | 'assistant',
      scope = first,
      sequence = 1,
    ) {
      return pool.query(
        'INSERT INTO workflow_messages ' +
        '(id, command_id, context_id, route_id, thread_id, stage_key, role, content, sequence) ' +
        "VALUES ($1, $2, $3, $4, $5, 'work', $6, $7, $8)",
        [
          randomUUID(),
          commandId,
          first.context,
          scope.route,
          scope.thread,
          role,
          marker,
          sequence,
        ],
      );
    }

    await pool.query(
      'UPDATE workflow_commands SET result_route_id = $2, result_thread_id = $3, ' +
      'result_checkpoint_id = $4 WHERE id = $1',
      [firstCommandId, alternate.route, alternate.thread, alternate.checkpoint],
    );
    await insertArtifact(firstCommandId, 'valid-source-artifact');
    await insertProposal(firstCommandId, 'valid-source-proposal');
    await insertMessage(firstCommandId, 'valid-source-message', 'user');
    await insertArtifact(firstCommandId, 'valid-result-artifact', alternate);
    await insertProposal(firstCommandId, 'valid-result-proposal', alternate);
    await insertMessage(firstCommandId, 'valid-result-message', 'assistant', alternate);
    await pool.query(
      'INSERT INTO workflow_interrupts ' +
      '(id, context_id, route_id, thread_id, stage_key, prompt, workflow_cursor, ' +
      'originating_command_id, status) ' +
      "VALUES ($1, $2, $3, $4, 'work', 'Continue?', '{}'::jsonb, $5, 'pending')",
      [randomUUID(), first.context, alternate.route, alternate.thread, firstCommandId],
    );

    await expect(insertArtifact(secondCommandId, 'cross-user-artifact'))
      .rejects.toMatchObject({ code: '23503' });
    await expect(insertProposal(secondCommandId, 'cross-user-proposal'))
      .rejects.toMatchObject({ code: '23503' });
    await expect(insertArtifact(alternateCommandId, 'wrong-route-artifact'))
      .rejects.toMatchObject({ code: '23503' });
    await expect(insertProposal(alternateCommandId, 'wrong-route-proposal'))
      .rejects.toMatchObject({ code: '23503' });
    await expect(insertMessage(alternateCommandId, 'wrong-route-message', 'user', first, 2))
      .rejects.toMatchObject({ code: '23503' });
  });

  it('enforces staged attachment ownership and one-time command adoption', async () => {
    await runMigrations({ pool, migrationsDir });
    const first = await createWorkflowFixture(pool);
    const second = await createWorkflowFixture(pool);
    const firstCommandId = await insertCommand(pool, first);

    async function insertAsset(userId: string, marker: 'a' | 'b') {
      const objectId = randomUUID();
      await pool.query(
        'INSERT INTO asset_objects ' +
          '(id, user_id, storage_key, sha256, byte_size, media_type, status) ' +
          "VALUES ($1, $2, $3, $4, 4, 'text/plain', 'ready')",
        [
          objectId,
          userId,
          `objects/staged/${objectId}`,
          marker.repeat(64),
        ],
      );
      return objectId;
    }

    const firstObjectId = await insertAsset(first.user, 'a');
    const secondObjectId = await insertAsset(second.user, 'b');

    await expect(pool.query(
      'INSERT INTO staged_attachments ' +
        '(id, user_id, object_id, filename, status, adopted_command_id, ' +
        'adopted_context_id, adopted_at) ' +
        "VALUES ($1, $2, $3, 'direct-adoption.txt', 'adopted', $4, $5, now())",
      [randomUUID(), first.user, firstObjectId, firstCommandId, first.context],
    )).rejects.toMatchObject({ code: '55000' });

    await expect(pool.query(
      'INSERT INTO staged_attachments (id, user_id, object_id, filename) ' +
        "VALUES ($1, $2, $3, 'cross-user.txt')",
      [randomUUID(), first.user, secondObjectId],
    )).rejects.toMatchObject({ code: '23503' });

    const deletablePendingId = randomUUID();
    await pool.query(
      'INSERT INTO staged_attachments (id, user_id, object_id, filename) ' +
        "VALUES ($1, $2, $3, 'discard-me.txt')",
      [deletablePendingId, first.user, firstObjectId],
    );
    const deletedPending = await pool.query(
      'DELETE FROM staged_attachments WHERE id = $1 RETURNING id',
      [deletablePendingId],
    );
    expect(deletedPending.rows).toEqual([{ id: deletablePendingId }]);

    const pendingId = randomUUID();
    await pool.query(
      'INSERT INTO staged_attachments (id, user_id, object_id, filename) ' +
        "VALUES ($1, $2, $3, 'draft.txt')",
      [pendingId, first.user, firstObjectId],
    );
    const pending = await pool.query(
      'SELECT status, adopted_command_id, adopted_context_id, adopted_at ' +
        'FROM staged_attachments WHERE id = $1',
      [pendingId],
    );
    expect(pending.rows).toEqual([{
      status: 'pending',
      adopted_command_id: null,
      adopted_context_id: null,
      adopted_at: null,
    }]);

    const partialId = randomUUID();
    await pool.query(
      'INSERT INTO staged_attachments (id, user_id, object_id, filename) ' +
        "VALUES ($1, $2, $3, 'partial.txt')",
      [partialId, first.user, firstObjectId],
    );
    await expect(pool.query(
      "UPDATE staged_attachments SET status = 'adopted', " +
        'adopted_command_id = $2, adopted_at = now() WHERE id = $1',
      [partialId, firstCommandId],
    )).rejects.toMatchObject({ code: '23514' });

    const mismatchedScopeId = randomUUID();
    await pool.query(
      'INSERT INTO staged_attachments (id, user_id, object_id, filename) ' +
        "VALUES ($1, $2, $3, 'wrong-command-context.txt')",
      [mismatchedScopeId, second.user, secondObjectId],
    );
    await expect(pool.query(
      "UPDATE staged_attachments SET status = 'adopted', " +
        'adopted_command_id = $2, adopted_context_id = $3, ' +
        'adopted_at = now(), updated_at = now() WHERE id = $1',
      [mismatchedScopeId, firstCommandId, second.context],
    )).rejects.toMatchObject({ code: '23503' });

    await pool.query(
      "UPDATE staged_attachments SET status = 'adopted', " +
        'adopted_command_id = $2, adopted_context_id = $3, ' +
        'adopted_at = $4, updated_at = $4 WHERE id = $1',
      [
        pendingId,
        firstCommandId,
        first.context,
        new Date('2026-07-17T12:30:00.000Z'),
      ],
    );
    const adopted = await pool.query(
      'SELECT status, adopted_command_id, adopted_context_id, ' +
        'adopted_at IS NOT NULL AS has_adopted_at ' +
        'FROM staged_attachments WHERE id = $1',
      [pendingId],
    );
    expect(adopted.rows).toEqual([{
      status: 'adopted',
      adopted_command_id: firstCommandId,
      adopted_context_id: first.context,
      has_adopted_at: true,
    }]);

    await expect(pool.query(
      'DELETE FROM staged_attachments WHERE id = $1',
      [pendingId],
    )).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query(
      "UPDATE staged_attachments SET filename = 'changed.txt' WHERE id = $1",
      [pendingId],
    )).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query(
      "UPDATE staged_attachments SET status = 'pending', " +
        'adopted_command_id = NULL, adopted_context_id = NULL, adopted_at = NULL ' +
        'WHERE id = $1',
      [pendingId],
    )).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query(
      "UPDATE staged_attachments SET status = 'adopted', adopted_at = now() " +
        'WHERE id = $1',
      [pendingId],
    )).rejects.toMatchObject({ code: '55000' });
  });

  it('allows only one non-archived primary Conversation per Route', async () => {
    await runMigrations({ pool, migrationsDir });
    const ids = await createWorkflowFixture(pool);

    await pool.query(
      'INSERT INTO workflow_threads ' +
        '(id, context_id, route_id, stage_key, title, title_source, is_primary, status) ' +
        "VALUES ($1, $2, $3, NULL, 'Primary', 'agent', true, 'active')",
      [randomUUID(), ids.context, ids.route],
    );
    await expect(pool.query(
      'INSERT INTO workflow_threads ' +
        '(id, context_id, route_id, stage_key, title, title_source, is_primary, status) ' +
        "VALUES ($1, $2, $3, NULL, 'Other primary', 'agent', true, 'active')",
      [randomUUID(), ids.context, ids.route],
    )).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(
      'INSERT INTO workflow_threads ' +
        '(id, context_id, route_id, stage_key, title, title_source, is_primary, status) ' +
        "VALUES ($1, $2, $3, NULL, 'Archived primary', 'agent', true, 'archived')",
      [randomUUID(), ids.context, ids.route],
    )).resolves.toBeDefined();
  });

  it('accepts only the three command kinds and their matching discriminator fields', async () => {
    await runMigrations({ pool, migrationsDir });
    const ids = await createWorkflowFixture(pool);

    await insertCommand(pool, ids);
    await insertCommand(pool, ids, { kind: 'named_action', actionKey: 'adopt_thread' });

    const interruptId = randomUUID();
    const originCommand = await insertCommand(pool, ids);
    await pool.query(
      'INSERT INTO workflow_interrupts ' +
        '(id, context_id, route_id, thread_id, stage_key, prompt, workflow_cursor, originating_command_id, status) ' +
        "VALUES ($1, $2, $3, $4, 'work', 'Need input', '{\"cursor\":1}'::jsonb, $5, 'pending')",
      [interruptId, ids.context, ids.route, ids.thread, originCommand],
    );
    await insertCommand(pool, ids, { kind: 'resume_interrupt', interruptId });

    await expect(pool.query(
      'INSERT INTO workflow_commands ' +
        '(id, context_id, source_route_id, source_thread_id, stage_key, base_checkpoint_id, expected_checkpoint_version, kind, content, input_hash, status) ' +
        "VALUES ($1, $2, $3, $4, 'work', $5, 0, 'freeform', 'Hello', 'sha256:invalid', 'pending')",
      [randomUUID(), ids.context, ids.route, ids.thread, ids.checkpoint],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(insertCommand(pool, ids, { kind: 'named_action' }))
      .rejects.toMatchObject({ code: '23514' });
    await expect(insertCommand(pool, ids, { kind: 'message', actionKey: 'advance' }))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('keeps messages and command events append-only', async () => {
    await runMigrations({ pool, migrationsDir });
    const ids = await createWorkflowFixture(pool);
    const commandId = await insertCommand(pool, ids);
    const messageId = randomUUID();

    await pool.query(
      'INSERT INTO workflow_messages (id, command_id, context_id, route_id, thread_id, stage_key, role, content, sequence) ' +
        "VALUES ($1, $2, $3, $4, $5, 'work', 'user', 'Hello', 1)",
      [messageId, commandId, ids.context, ids.route, ids.thread],
    );
    await pool.query(
      'INSERT INTO workflow_command_events (command_id, sequence, event_type, payload) ' +
        "VALUES ($1, 1, 'command.accepted', '{\"status\":\"pending\"}'::jsonb)",
      [commandId],
    );
    for (const [sequence, eventType] of [
      [2, 'workflow.started'],
      [3, 'assistant.delta'],
      [4, 'workspace.committed'],
      [5, 'command.finished'],
    ] as const) {
      await pool.query(
        'INSERT INTO workflow_command_events (command_id, sequence, event_type, payload) VALUES ($1, $2, $3, $4)',
        [commandId, sequence, eventType, {}],
      );
    }

    await expect(pool.query(
      'INSERT INTO workflow_command_events (command_id, sequence, event_type, payload) VALUES ($1, 5, $2, $3)',
      [commandId, 'command.finished', {}],
    )).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(
      'INSERT INTO workflow_command_events (command_id, sequence, event_type, payload) VALUES ($1, 6, $2, $3)',
      [commandId, 'workflow.secret', {}],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(pool.query(
      "UPDATE workflow_messages SET content = 'Changed' WHERE id = $1",
      [messageId],
    )).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query('DELETE FROM workflow_messages WHERE id = $1', [messageId]))
      .rejects.toMatchObject({ code: '55000' });
    await expect(pool.query(
      "UPDATE workflow_command_events SET event_type = 'workflow.started' WHERE command_id = $1 AND sequence = 1",
      [commandId],
    )).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query(
      'DELETE FROM workflow_command_events WHERE command_id = $1 AND sequence = 1',
      [commandId],
    )).rejects.toMatchObject({ code: '55000' });
  });

  it('enforces thread-scoped messages, sequences, roles, and source references', async () => {
    await runMigrations({ pool, migrationsDir });
    const first = await createWorkflowFixture(pool);
    const second = await createWorkflowFixture(pool);
    const commandId = await insertCommand(pool, first);
    const messageId = randomUUID();

    await pool.query(
      'INSERT INTO workflow_messages (id, command_id, context_id, route_id, thread_id, stage_key, role, content, sequence) ' +
        "VALUES ($1, $2, $3, $4, $5, 'work', 'user', 'Hello', 1)",
      [messageId, commandId, first.context, first.route, first.thread],
    );

    await expect(pool.query(
      'INSERT INTO workflow_messages (id, command_id, context_id, route_id, thread_id, stage_key, role, content, sequence) ' +
        "VALUES ($1, $2, $3, $4, $5, 'work', 'assistant', 'Duplicate sequence', 1)",
      [randomUUID(), commandId, first.context, first.route, first.thread],
    )).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(
      'INSERT INTO workflow_messages (id, command_id, context_id, route_id, thread_id, stage_key, role, content, sequence) ' +
        "VALUES ($1, $2, $3, $4, $5, 'work', 'assistant', 'Wrong scope', 2)",
      [randomUUID(), commandId, second.context, first.route, first.thread],
    )).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(
      'INSERT INTO workflow_messages (id, command_id, context_id, route_id, thread_id, stage_key, role, content, sequence) ' +
        "VALUES ($1, $2, $3, $4, $5, 'work', 'assistant', 'Wrong command context', 1)",
      [randomUUID(), commandId, second.context, second.route, second.thread],
    )).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(
      'INSERT INTO workflow_messages (id, command_id, context_id, route_id, thread_id, stage_key, role, content, sequence, source_message_id) ' +
        "VALUES ($1, $2, $3, $4, $5, 'work', 'assistant', 'Wrong source', 1, $6)",
      [randomUUID(), commandId, second.context, second.route, second.thread, messageId],
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects command ID reuse and result resources outside the command context', async () => {
    await runMigrations({ pool, migrationsDir });
    const first = await createWorkflowFixture(pool);
    const second = await createWorkflowFixture(pool);
    const commandId = await insertCommand(pool, first, { inputHash: 'sha256:first' });

    await expect(insertCommand(pool, first, {
      id: commandId,
      inputHash: 'sha256:different',
    })).rejects.toMatchObject({ code: '23505' });

    await expect(pool.query(
      'UPDATE workflow_commands SET expected_checkpoint_version = 1 WHERE id = $1',
      [commandId],
    )).rejects.toMatchObject({ code: '23503' });

    await expect(pool.query(
      'UPDATE workflow_commands SET result_checkpoint_id = $2 WHERE id = $1',
      [commandId, second.checkpoint],
    )).rejects.toMatchObject({ code: '23514' });

    await expect(pool.query(
      'UPDATE workflow_commands SET result_route_id = $2, result_thread_id = $3, result_checkpoint_id = $4 WHERE id = $1',
      [commandId, second.route, second.thread, second.checkpoint],
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('scopes origin threads to Context and allows differing legacy Stage metadata', async () => {
    await runMigrations({ pool, migrationsDir });
    const first = await createWorkflowFixture(pool);
    const second = await createWorkflowFixture(pool);
    const derivedThreadId = randomUUID();

    const derived = await pool.query(
      'INSERT INTO workflow_threads ' +
        '(id, context_id, route_id, stage_key, title, origin_thread_id) ' +
        "VALUES ($1, $2, $3, 'decide', 'Derived conversation', $4) " +
        'RETURNING context_id, stage_key, origin_thread_id',
      [derivedThreadId, first.context, first.route, first.thread],
    );
    expect(derived.rows).toEqual([{
      context_id: first.context,
      stage_key: 'decide',
      origin_thread_id: first.thread,
    }]);

    await expect(pool.query(
      'UPDATE workflow_threads SET origin_thread_id = $2 WHERE id = $1',
      [second.thread, first.thread],
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('allows only one pending interrupt per thread and excludes resolved interrupts from pending queries', async () => {
    await runMigrations({ pool, migrationsDir });
    const ids = await createWorkflowFixture(pool);
    const originCommand = await insertCommand(pool, ids);
    const firstInterrupt = randomUUID();

    await pool.query(
      'INSERT INTO workflow_interrupts ' +
        '(id, context_id, route_id, thread_id, stage_key, prompt, workflow_cursor, originating_command_id, status) ' +
        "VALUES ($1, $2, $3, $4, 'work', 'First prompt', '{\"cursor\":1}'::jsonb, $5, 'pending')",
      [firstInterrupt, ids.context, ids.route, ids.thread, originCommand],
    );
    await expect(pool.query(
      'INSERT INTO workflow_interrupts ' +
        '(id, context_id, route_id, thread_id, stage_key, prompt, workflow_cursor, originating_command_id, status) ' +
        "VALUES ($1, $2, $3, $4, 'work', 'Second prompt', '{\"cursor\":2}'::jsonb, $5, 'pending')",
      [randomUUID(), ids.context, ids.route, ids.thread, originCommand],
    )).rejects.toMatchObject({ code: '23505' });

    const resolutionCommand = await insertCommand(pool, ids, {
      kind: 'resume_interrupt',
      interruptId: firstInterrupt,
    });
    await pool.query(
      "UPDATE workflow_interrupts SET status = 'resolved', resolution_command_id = $2, resolved_at = now(), updated_at = now() WHERE id = $1",
      [firstInterrupt, resolutionCommand],
    );

    const pending = await pool.query(
      "SELECT id, prompt FROM workflow_interrupts WHERE thread_id = $1 AND status = 'pending'",
      [ids.thread],
    );
    expect(pending.rows).toEqual([]);

    await pool.query(
      'INSERT INTO workflow_interrupts ' +
        '(id, context_id, route_id, thread_id, stage_key, prompt, workflow_cursor, originating_command_id, status) ' +
        "VALUES ($1, $2, $3, $4, 'work', 'Next prompt', '{\"cursor\":3}'::jsonb, $5, 'pending')",
      [randomUUID(), ids.context, ids.route, ids.thread, resolutionCommand],
    );
  });

  it('serializes concurrent migration attempts', async () => {
    await Promise.all([
      runMigrations({ pool, migrationsDir }),
      runMigrations({ pool, migrationsDir }),
    ]);

    const applied = await pool.query(
      "SELECT count(*)::int AS count FROM schema_migrations WHERE version = '0001_identity'",
    );
    expect(applied.rows[0]?.count).toBe(1);
  });

  it('rolls back failed transactions', async () => {
    await pool.query('CREATE TABLE transaction_probe (value text NOT NULL)');

    await expect(withTransaction(pool, async (client) => {
      await client.query('INSERT INTO transaction_probe (value) VALUES ($1)', ['uncommitted']);
      throw new Error('stop');
    })).rejects.toThrow('stop');

    const result = await pool.query('SELECT value FROM transaction_probe');
    expect(result.rows).toEqual([]);
  });

  it('rejects a changed checksum for an applied migration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'polar-native-migrations-'));
    try {
      const migrationPath = join(directory, '0001_identity.sql');
      await writeFile(migrationPath, 'CREATE TABLE checksum_probe (id integer);');
      await runMigrations({ pool, migrationsDir: directory });

      await writeFile(migrationPath, 'CREATE TABLE checksum_probe_changed (id integer);');
      await expect(runMigrations({ pool, migrationsDir: directory }))
        .rejects.toThrow(/checksum mismatch/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps checkpoints immutable in PostgreSQL', async () => {
    await runMigrations({ pool, migrationsDir });
    const ids = {
      user: '00000000-0000-4000-8000-000000000001',
      context: '00000000-0000-4000-8000-000000000002',
      route: '00000000-0000-4000-8000-000000000003',
      checkpoint: '00000000-0000-4000-8000-000000000004',
    };
    await pool.query(
      "INSERT INTO users (id, email, email_normalized, username, username_normalized, password_hash, email_verified_at, status, created_via) VALUES ($1, 'domain@example.test', 'domain@example.test', 'domain', 'domain', 'hash', now(), 'active', 'admin_cli')",
      [ids.user],
    );
    await pool.query('INSERT INTO contexts (id, user_id, title) VALUES ($1, $2, $3)', [ids.context, ids.user, 'Context']);
    await withTransaction(pool, async (client) => {
      await client.query('INSERT INTO workflow_routes (id, context_id, name) VALUES ($1, $2, $3)', [ids.route, ids.context, 'Main']);
      await client.query(
        "INSERT INTO workflow_checkpoints (id, context_id, route_id, version, stage_key, reason, snapshot) VALUES ($1, $2, $3, 0, 'work', 'bootstrap', '{\"stages\":[]}'::jsonb)",
        [ids.checkpoint, ids.context, ids.route],
      );
      await client.query('UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1', [ids.route, ids.checkpoint]);
    });

    await expect(pool.query(
      'UPDATE workflow_checkpoints ' +
        `SET snapshot = '{"workflowState":{"changed":true}}'::jsonb WHERE id = $1`,
      [ids.checkpoint],
    )).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query('DELETE FROM workflow_checkpoints WHERE id = $1', [ids.checkpoint]))
      .rejects.toMatchObject({ code: '55000' });
  });

  it('rejects a route whose head checkpoint is null at transaction commit', async () => {
    await runMigrations({ pool, migrationsDir });
    const ids = {
      user: '10000000-0000-4000-8000-000000000001',
      context: '10000000-0000-4000-8000-000000000002',
      route: '10000000-0000-4000-8000-000000000003',
    };
    await pool.query(
      "INSERT INTO users (id, email, email_normalized, username, username_normalized, password_hash, email_verified_at, status, created_via) VALUES ($1, 'head@example.test', 'head@example.test', 'head', 'head', 'hash', now(), 'active', 'admin_cli')",
      [ids.user],
    );
    await pool.query('INSERT INTO contexts (id, user_id, title) VALUES ($1, $2, $3)', [ids.context, ids.user, 'Context']);

    await expect(withTransaction(pool, async (client) => {
      await client.query(
        'INSERT INTO workflow_routes (id, context_id, name) VALUES ($1, $2, $3)',
        [ids.route, ids.context, 'Incomplete route'],
      );
    })).rejects.toMatchObject({ code: '23514' });
  });

  it('requires checkpoint parents to belong to the same context and route', async () => {
    await runMigrations({ pool, migrationsDir });
    const ids = {
      user: '20000000-0000-4000-8000-000000000001',
      context: '20000000-0000-4000-8000-000000000002',
      firstRoute: '20000000-0000-4000-8000-000000000003',
      firstCheckpoint: '20000000-0000-4000-8000-000000000004',
      secondRoute: '20000000-0000-4000-8000-000000000005',
      secondCheckpoint: '20000000-0000-4000-8000-000000000006',
      invalidChild: '20000000-0000-4000-8000-000000000007',
    };
    await pool.query(
      "INSERT INTO users (id, email, email_normalized, username, username_normalized, password_hash, email_verified_at, status, created_via) VALUES ($1, 'parent@example.test', 'parent@example.test', 'parent', 'parent', 'hash', now(), 'active', 'admin_cli')",
      [ids.user],
    );
    await pool.query('INSERT INTO contexts (id, user_id, title) VALUES ($1, $2, $3)', [ids.context, ids.user, 'Context']);
    await withTransaction(pool, async (client) => {
      for (const [routeId, checkpointId, routeName] of [
        [ids.firstRoute, ids.firstCheckpoint, 'First'],
        [ids.secondRoute, ids.secondCheckpoint, 'Second'],
      ]) {
        await client.query(
          'INSERT INTO workflow_routes (id, context_id, name) VALUES ($1, $2, $3)',
          [routeId, ids.context, routeName],
        );
        await client.query(
          "INSERT INTO workflow_checkpoints (id, context_id, route_id, version, stage_key, reason, snapshot) VALUES ($1, $2, $3, 0, 'work', 'bootstrap', '{\"stages\":[]}'::jsonb)",
          [checkpointId, ids.context, routeId],
        );
        await client.query('UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1', [routeId, checkpointId]);
      }
    });

    await expect(pool.query(
      "INSERT INTO workflow_checkpoints (id, context_id, route_id, parent_checkpoint_id, version, stage_key, reason, snapshot) VALUES ($1, $2, $3, $4, 1, 'work', 'workflow_action', '{\"stages\":[]}'::jsonb)",
      [ids.invalidChild, ids.context, ids.secondRoute, ids.firstCheckpoint],
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('keeps a legacy thread Stage as metadata without requiring a matching projection', async () => {
    await runMigrations({ pool, migrationsDir });
    const ids = {
      user: '30000000-0000-4000-8000-000000000001',
      context: '30000000-0000-4000-8000-000000000002',
      route: '30000000-0000-4000-8000-000000000003',
      checkpoint: '30000000-0000-4000-8000-000000000004',
      thread: '30000000-0000-4000-8000-000000000005',
    };
    await pool.query(
      "INSERT INTO users (id, email, email_normalized, username, username_normalized, password_hash, email_verified_at, status, created_via) VALUES ($1, 'stage@example.test', 'stage@example.test', 'stage', 'stage', 'hash', now(), 'active', 'admin_cli')",
      [ids.user],
    );
    await pool.query('INSERT INTO contexts (id, user_id, title) VALUES ($1, $2, $3)', [ids.context, ids.user, 'Context']);
    await withTransaction(pool, async (client) => {
      await client.query('INSERT INTO workflow_routes (id, context_id, name) VALUES ($1, $2, $3)', [ids.route, ids.context, 'Main']);
      await client.query(
        "INSERT INTO workflow_checkpoints (id, context_id, route_id, version, stage_key, reason, snapshot) VALUES ($1, $2, $3, 0, 'discover', 'bootstrap', '{\"stages\":[]}'::jsonb)",
        [ids.checkpoint, ids.context, ids.route],
      );
      await client.query('UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1', [ids.route, ids.checkpoint]);
    });
    await pool.query(
      "INSERT INTO route_stage_projections (route_id, stage_key, position, status, internal_state) VALUES ($1, 'discover', 0, 'active', 'start')",
      [ids.route],
    );

    const conversation = await pool.query(
      "INSERT INTO workflow_threads (id, context_id, route_id, stage_key, title) " +
        "VALUES ($1, $2, $3, 'decide', 'Legacy stage label') RETURNING stage_key",
      [ids.thread, ids.context, ids.route],
    );
    expect(conversation.rows).toEqual([{ stage_key: 'decide' }]);
  });

  it('keeps route origin checkpoints immutable after insert', async () => {
    await runMigrations({ pool, migrationsDir });
    const ids = {
      user: '40000000-0000-4000-8000-000000000001',
      context: '40000000-0000-4000-8000-000000000002',
      sourceRoute: '40000000-0000-4000-8000-000000000003',
      sourceCheckpoint: '40000000-0000-4000-8000-000000000004',
      branchRoute: '40000000-0000-4000-8000-000000000005',
      branchCheckpoint: '40000000-0000-4000-8000-000000000006',
    };
    await pool.query(
      "INSERT INTO users (id, email, email_normalized, username, username_normalized, password_hash, email_verified_at, status, created_via) VALUES ($1, 'origin@example.test', 'origin@example.test', 'origin', 'origin', 'hash', now(), 'active', 'admin_cli')",
      [ids.user],
    );
    await pool.query('INSERT INTO contexts (id, user_id, title) VALUES ($1, $2, $3)', [ids.context, ids.user, 'Context']);
    await withTransaction(pool, async (client) => {
      await client.query('INSERT INTO workflow_routes (id, context_id, name) VALUES ($1, $2, $3)', [ids.sourceRoute, ids.context, 'Source']);
      await client.query(
        "INSERT INTO workflow_checkpoints (id, context_id, route_id, version, stage_key, reason, snapshot) VALUES ($1, $2, $3, 0, 'work', 'bootstrap', '{\"stages\":[]}'::jsonb)",
        [ids.sourceCheckpoint, ids.context, ids.sourceRoute],
      );
      await client.query('UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1', [ids.sourceRoute, ids.sourceCheckpoint]);
      await client.query(
        'INSERT INTO workflow_routes (id, context_id, name, origin_checkpoint_id) VALUES ($1, $2, $3, $4)',
        [ids.branchRoute, ids.context, 'Branch', ids.sourceCheckpoint],
      );
      await client.query(
        "INSERT INTO workflow_checkpoints (id, context_id, route_id, version, stage_key, reason, snapshot) VALUES ($1, $2, $3, 0, 'work', 'branch', '{\"stages\":[]}'::jsonb)",
        [ids.branchCheckpoint, ids.context, ids.branchRoute],
      );
      await client.query('UPDATE workflow_routes SET head_checkpoint_id = $2 WHERE id = $1', [ids.branchRoute, ids.branchCheckpoint]);
    });

    await expect(pool.query(
      'UPDATE workflow_routes SET origin_checkpoint_id = NULL WHERE id = $1',
      [ids.branchRoute],
    )).rejects.toMatchObject({ code: '55000' });
  });
});
