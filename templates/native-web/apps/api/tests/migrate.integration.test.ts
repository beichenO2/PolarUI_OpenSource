import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    ]);

    const tables = await pool.query<{ table_name: string }>(
      'SELECT table_name ' +
        'FROM information_schema.tables ' +
        'WHERE table_schema = $2 ' +
        'AND table_name = ANY($1::text[]) ' +
        'ORDER BY table_name',
      [[
        'auth_sessions',
        'contexts',
        'email_verifications',
        'route_stage_projections',
        'users',
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
      'auth_sessions',
      'contexts',
      'email_verifications',
      'route_stage_projections',
      'users',
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

  it('requires an origin thread to remain in the derived thread context and stage', async () => {
    await runMigrations({ pool, migrationsDir });
    const first = await createWorkflowFixture(pool);
    const second = await createWorkflowFixture(pool);

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
      "UPDATE workflow_checkpoints SET reason = 'changed' WHERE id = $1",
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

  it('requires every thread stage to exist in its route projections', async () => {
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

    await expect(pool.query(
      "INSERT INTO workflow_threads (id, context_id, route_id, stage_key, title) VALUES ($1, $2, $3, 'decide', 'Invalid stage')",
      [ids.thread, ids.context, ids.route],
    )).rejects.toMatchObject({ code: '23503' });
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
