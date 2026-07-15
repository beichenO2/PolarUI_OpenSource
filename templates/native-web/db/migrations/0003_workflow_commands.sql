ALTER TABLE workflow_threads
  ADD COLUMN origin_thread_id uuid,
  ADD CONSTRAINT workflow_threads_id_context_route_stage_unique
    UNIQUE (id, context_id, route_id, stage_key),
  ADD CONSTRAINT workflow_threads_id_context_stage_unique
    UNIQUE (id, context_id, stage_key),
  ADD CONSTRAINT workflow_threads_origin_scope_fk
    FOREIGN KEY (origin_thread_id, context_id, stage_key)
    REFERENCES workflow_threads(id, context_id, stage_key)
    ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_threads_origin_not_self
    CHECK (origin_thread_id IS NULL OR origin_thread_id <> id);

ALTER TABLE workflow_checkpoints
  ADD CONSTRAINT workflow_checkpoints_id_route_context_version_unique
    UNIQUE (id, route_id, context_id, version);

CREATE TABLE workflow_commands (
  id uuid PRIMARY KEY,
  context_id uuid NOT NULL,
  source_route_id uuid NOT NULL,
  source_thread_id uuid NOT NULL,
  stage_key text NOT NULL,
  base_checkpoint_id uuid NOT NULL,
  expected_checkpoint_version integer NOT NULL,
  kind text NOT NULL,
  action_key text,
  interrupt_id uuid,
  content text NOT NULL,
  input_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt integer NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  result_route_id uuid,
  result_thread_id uuid,
  result_checkpoint_id uuid,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_commands_source_route_scope_fk
    FOREIGN KEY (source_route_id, context_id)
    REFERENCES workflow_routes(id, context_id)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_commands_source_thread_scope_fk
    FOREIGN KEY (source_thread_id, context_id, source_route_id, stage_key)
    REFERENCES workflow_threads(id, context_id, route_id, stage_key)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_commands_base_checkpoint_scope_fk
    FOREIGN KEY (base_checkpoint_id, source_route_id, context_id, expected_checkpoint_version)
    REFERENCES workflow_checkpoints(id, route_id, context_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_commands_result_route_scope_fk
    FOREIGN KEY (result_route_id, context_id)
    REFERENCES workflow_routes(id, context_id)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_commands_result_thread_scope_fk
    FOREIGN KEY (result_thread_id, context_id, result_route_id, stage_key)
    REFERENCES workflow_threads(id, context_id, route_id, stage_key)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_commands_result_checkpoint_scope_fk
    FOREIGN KEY (result_checkpoint_id, result_route_id, context_id)
    REFERENCES workflow_checkpoints(id, route_id, context_id)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_commands_expected_version_valid
    CHECK (expected_checkpoint_version >= 0),
  CONSTRAINT workflow_commands_kind_valid
    CHECK (kind IN ('message', 'named_action', 'resume_interrupt')),
  CONSTRAINT workflow_commands_kind_fields_valid
    CHECK (
      (kind = 'message' AND action_key IS NULL AND interrupt_id IS NULL)
      OR (kind = 'named_action' AND action_key IS NOT NULL AND interrupt_id IS NULL)
      OR (kind = 'resume_interrupt' AND action_key IS NULL AND interrupt_id IS NOT NULL)
    ),
  CONSTRAINT workflow_commands_action_key_valid
    CHECK (action_key IS NULL OR action_key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT workflow_commands_content_valid
    CHECK (char_length(content) > 0),
  CONSTRAINT workflow_commands_input_hash_valid
    CHECK (char_length(input_hash) > 0),
  CONSTRAINT workflow_commands_status_valid
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'conflict')),
  CONSTRAINT workflow_commands_attempt_valid
    CHECK (attempt >= 0),
  CONSTRAINT workflow_commands_result_presence_valid
    CHECK (
      (result_thread_id IS NULL OR result_route_id IS NOT NULL)
      AND (result_checkpoint_id IS NULL OR result_route_id IS NOT NULL)
    ),
  CONSTRAINT workflow_commands_stage_key_valid
    CHECK (stage_key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT workflow_commands_id_context_stage_unique
    UNIQUE (id, context_id, stage_key),
  CONSTRAINT workflow_commands_id_scope_unique
    UNIQUE (id, context_id, source_route_id, source_thread_id, stage_key)
);

CREATE INDEX workflow_commands_thread_created_idx
  ON workflow_commands (source_thread_id, created_at, id);

CREATE INDEX workflow_commands_status_lease_idx
  ON workflow_commands (status, lease_expires_at)
  WHERE status IN ('pending', 'running');

CREATE UNIQUE INDEX workflow_commands_interrupt_resume_once
  ON workflow_commands (interrupt_id)
  WHERE kind = 'resume_interrupt';

CREATE TABLE workflow_command_events (
  command_id uuid NOT NULL REFERENCES workflow_commands(id) ON DELETE RESTRICT,
  sequence integer NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (command_id, sequence),
  CONSTRAINT workflow_command_events_sequence_valid CHECK (sequence >= 1),
  CONSTRAINT workflow_command_events_type_valid CHECK (
    event_type IN (
      'command.accepted',
      'workflow.started',
      'assistant.delta',
      'workspace.committed',
      'command.finished'
    )
  ),
  CONSTRAINT workflow_command_events_payload_valid CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE workflow_messages (
  id uuid PRIMARY KEY,
  command_id uuid NOT NULL,
  context_id uuid NOT NULL,
  route_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  stage_key text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  sequence integer NOT NULL,
  source_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_messages_thread_scope_fk
    FOREIGN KEY (thread_id, context_id, route_id, stage_key)
    REFERENCES workflow_threads(id, context_id, route_id, stage_key)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_messages_command_scope_fk
    FOREIGN KEY (command_id, context_id, stage_key)
    REFERENCES workflow_commands(id, context_id, stage_key)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_messages_role_valid CHECK (role IN ('user', 'assistant')),
  CONSTRAINT workflow_messages_content_valid CHECK (char_length(content) > 0),
  CONSTRAINT workflow_messages_sequence_valid CHECK (sequence >= 1),
  CONSTRAINT workflow_messages_stage_key_valid CHECK (stage_key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT workflow_messages_thread_sequence_unique UNIQUE (thread_id, sequence),
  CONSTRAINT workflow_messages_command_role_unique UNIQUE (command_id, role),
  CONSTRAINT workflow_messages_id_context_stage_unique UNIQUE (id, context_id, stage_key),
  CONSTRAINT workflow_messages_source_context_fk
    FOREIGN KEY (source_message_id, context_id, stage_key)
    REFERENCES workflow_messages(id, context_id, stage_key)
    ON DELETE RESTRICT
);

CREATE INDEX workflow_messages_thread_sequence_idx
  ON workflow_messages (thread_id, sequence);

CREATE TABLE workflow_interrupts (
  id uuid PRIMARY KEY,
  context_id uuid NOT NULL,
  route_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  stage_key text NOT NULL,
  prompt text NOT NULL,
  workflow_cursor jsonb NOT NULL,
  originating_command_id uuid NOT NULL,
  action_key text,
  status text NOT NULL DEFAULT 'pending',
  resolution_command_id uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_interrupts_thread_scope_fk
    FOREIGN KEY (thread_id, context_id, route_id, stage_key)
    REFERENCES workflow_threads(id, context_id, route_id, stage_key)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_interrupts_origin_command_scope_fk
    FOREIGN KEY (originating_command_id, context_id, route_id, thread_id, stage_key)
    REFERENCES workflow_commands(id, context_id, source_route_id, source_thread_id, stage_key)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_interrupts_resolution_command_scope_fk
    FOREIGN KEY (resolution_command_id, context_id, route_id, thread_id, stage_key)
    REFERENCES workflow_commands(id, context_id, source_route_id, source_thread_id, stage_key)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_interrupts_prompt_valid CHECK (char_length(prompt) > 0),
  CONSTRAINT workflow_interrupts_cursor_valid CHECK (jsonb_typeof(workflow_cursor) = 'object'),
  CONSTRAINT workflow_interrupts_action_key_valid
    CHECK (action_key IS NULL OR action_key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT workflow_interrupts_status_valid CHECK (status IN ('pending', 'resolved')),
  CONSTRAINT workflow_interrupts_resolution_valid CHECK (
    (status = 'pending' AND resolution_command_id IS NULL AND resolved_at IS NULL)
    OR (status = 'resolved' AND resolution_command_id IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT workflow_interrupts_id_scope_unique
    UNIQUE (id, context_id, route_id, thread_id, stage_key)
);

CREATE UNIQUE INDEX workflow_interrupts_one_pending_per_thread
  ON workflow_interrupts (context_id, route_id, stage_key, thread_id)
  WHERE status = 'pending';

CREATE INDEX workflow_interrupts_thread_created_idx
  ON workflow_interrupts (thread_id, created_at DESC, id);

ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_interrupt_scope_fk
    FOREIGN KEY (interrupt_id, context_id, source_route_id, source_thread_id, stage_key)
    REFERENCES workflow_interrupts(id, context_id, route_id, thread_id, stage_key)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION reject_workflow_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER workflow_command_events_append_only
BEFORE UPDATE OR DELETE ON workflow_command_events
FOR EACH ROW EXECUTE FUNCTION reject_workflow_append_only_mutation();

CREATE TRIGGER workflow_messages_append_only
BEFORE UPDATE OR DELETE ON workflow_messages
FOR EACH ROW EXECUTE FUNCTION reject_workflow_append_only_mutation();
