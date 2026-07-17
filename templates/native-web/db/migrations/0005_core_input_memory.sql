ALTER TABLE contexts
  DROP CONSTRAINT contexts_status_valid,
  ADD COLUMN title_source text NOT NULL DEFAULT 'user',
  ADD CONSTRAINT contexts_title_source_valid
    CHECK (title_source IN ('agent', 'user')),
  ADD CONSTRAINT contexts_status_valid
    CHECK (status IN ('initializing', 'active', 'archived'));

ALTER TABLE workflow_routes
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD CONSTRAINT workflow_routes_status_valid
    CHECK (status IN ('initializing', 'active', 'archived'));

-- Remove Stage-bearing foreign keys before replacing their referenced
-- uniqueness constraints with Context/Route ownership constraints.
ALTER TABLE workflow_commands
  DROP CONSTRAINT workflow_commands_source_thread_scope_fk,
  DROP CONSTRAINT workflow_commands_result_thread_scope_fk,
  DROP CONSTRAINT workflow_commands_interrupt_scope_fk;

ALTER TABLE workflow_messages
  DROP CONSTRAINT workflow_messages_thread_scope_fk,
  DROP CONSTRAINT workflow_messages_command_scope_fk,
  DROP CONSTRAINT workflow_messages_source_context_fk;

ALTER TABLE workflow_interrupts
  DROP CONSTRAINT workflow_interrupts_thread_scope_fk,
  DROP CONSTRAINT workflow_interrupts_origin_command_scope_fk,
  DROP CONSTRAINT workflow_interrupts_resolution_command_scope_fk;

ALTER TABLE workflow_attachments
  DROP CONSTRAINT workflow_attachments_thread_scope_fk;

ALTER TABLE workflow_artifacts
  DROP CONSTRAINT workflow_artifacts_thread_scope_fk,
  DROP CONSTRAINT workflow_artifacts_command_fk;

ALTER TABLE memory_proposals
  DROP CONSTRAINT memory_proposals_thread_scope_fk,
  DROP CONSTRAINT memory_proposals_command_fk;

ALTER TABLE workflow_threads
  DROP CONSTRAINT workflow_threads_route_stage_fk,
  DROP CONSTRAINT workflow_threads_origin_scope_fk;

DROP INDEX workflow_interrupts_one_pending_per_thread;

ALTER TABLE workflow_checkpoints
  ALTER COLUMN stage_key DROP NOT NULL;

ALTER TABLE workflow_threads
  DROP CONSTRAINT workflow_threads_id_context_route_stage_unique,
  DROP CONSTRAINT workflow_threads_id_context_stage_unique;

ALTER TABLE workflow_commands
  DROP CONSTRAINT workflow_commands_id_context_stage_unique,
  DROP CONSTRAINT workflow_commands_id_scope_unique;

ALTER TABLE workflow_messages
  DROP CONSTRAINT workflow_messages_id_context_stage_unique;

ALTER TABLE workflow_interrupts
  DROP CONSTRAINT workflow_interrupts_id_scope_unique;

ALTER TABLE workflow_threads
  DROP CONSTRAINT workflow_threads_status_valid,
  ADD COLUMN title_source text NOT NULL DEFAULT 'user',
  ADD COLUMN is_primary boolean NOT NULL DEFAULT false,
  ALTER COLUMN stage_key DROP NOT NULL,
  ADD CONSTRAINT workflow_threads_title_source_valid
    CHECK (title_source IN ('agent', 'user')),
  ADD CONSTRAINT workflow_threads_status_valid
    CHECK (status IN ('initializing', 'active', 'archived')),
  ADD CONSTRAINT workflow_threads_id_context_route_unique
    UNIQUE (id, context_id, route_id),
  ADD CONSTRAINT workflow_threads_id_context_unique
    UNIQUE (id, context_id),
  ADD CONSTRAINT workflow_threads_origin_scope_fk
    FOREIGN KEY (origin_thread_id, context_id)
    REFERENCES workflow_threads(id, context_id)
    ON DELETE RESTRICT;

-- Stage values remain readable compatibility metadata, but no public
-- causal row requires one after this migration.
ALTER TABLE workflow_commands
  ALTER COLUMN stage_key DROP NOT NULL,
  ADD CONSTRAINT workflow_commands_id_context_unique
    UNIQUE (id, context_id),
  ADD CONSTRAINT workflow_commands_id_scope_unique
    UNIQUE (id, context_id, source_route_id, source_thread_id),
  ADD CONSTRAINT workflow_commands_source_thread_scope_fk
    FOREIGN KEY (source_thread_id, context_id, source_route_id)
    REFERENCES workflow_threads(id, context_id, route_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_commands_result_thread_scope_fk
    FOREIGN KEY (result_thread_id, context_id, result_route_id)
    REFERENCES workflow_threads(id, context_id, route_id)
    ON DELETE RESTRICT;

ALTER TABLE workflow_messages
  ALTER COLUMN stage_key DROP NOT NULL,
  ADD CONSTRAINT workflow_messages_id_context_unique
    UNIQUE (id, context_id),
  ADD CONSTRAINT workflow_messages_thread_scope_fk
    FOREIGN KEY (thread_id, context_id, route_id)
    REFERENCES workflow_threads(id, context_id, route_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_messages_command_scope_fk
    FOREIGN KEY (command_id, context_id)
    REFERENCES workflow_commands(id, context_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_messages_source_context_fk
    FOREIGN KEY (source_message_id, context_id)
    REFERENCES workflow_messages(id, context_id)
    ON DELETE RESTRICT;

ALTER TABLE workflow_interrupts
  ALTER COLUMN stage_key DROP NOT NULL,
  ADD CONSTRAINT workflow_interrupts_id_scope_unique
    UNIQUE (id, context_id, route_id, thread_id),
  ADD CONSTRAINT workflow_interrupts_thread_scope_fk
    FOREIGN KEY (thread_id, context_id, route_id)
    REFERENCES workflow_threads(id, context_id, route_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_interrupts_origin_command_scope_fk
    FOREIGN KEY (originating_command_id, context_id)
    REFERENCES workflow_commands(id, context_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_interrupts_resolution_command_scope_fk
    FOREIGN KEY (resolution_command_id, context_id, route_id, thread_id)
    REFERENCES workflow_commands(id, context_id, source_route_id, source_thread_id)
    ON DELETE RESTRICT;

ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_interrupt_scope_fk
    FOREIGN KEY (interrupt_id, context_id, source_route_id, source_thread_id)
    REFERENCES workflow_interrupts(id, context_id, route_id, thread_id)
    ON DELETE RESTRICT;

ALTER TABLE workflow_attachments
  ALTER COLUMN stage_key DROP NOT NULL,
  ADD CONSTRAINT workflow_attachments_thread_scope_fk
    FOREIGN KEY (thread_id, context_id, route_id)
    REFERENCES workflow_threads(id, context_id, route_id)
    ON DELETE CASCADE;

ALTER TABLE workflow_artifacts
  ALTER COLUMN stage_key DROP NOT NULL,
  ADD CONSTRAINT workflow_artifacts_command_scope_fk
    FOREIGN KEY (command_id, context_id)
    REFERENCES workflow_commands(id, context_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT workflow_artifacts_thread_scope_fk
    FOREIGN KEY (thread_id, context_id, route_id)
    REFERENCES workflow_threads(id, context_id, route_id)
    ON DELETE RESTRICT;

ALTER TABLE memory_proposals
  ALTER COLUMN stage_key DROP NOT NULL,
  ADD CONSTRAINT memory_proposals_command_scope_fk
    FOREIGN KEY (command_id, context_id)
    REFERENCES workflow_commands(id, context_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT memory_proposals_thread_scope_fk
    FOREIGN KEY (thread_id, context_id, route_id)
    REFERENCES workflow_threads(id, context_id, route_id)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION validate_workflow_command_causal_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  causal_command_id uuid;
  command_scope record;
BEGIN
  causal_command_id := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  SELECT
    source_route_id,
    source_thread_id,
    result_route_id,
    result_thread_id
  INTO command_scope
  FROM workflow_commands
  WHERE id = causal_command_id
    AND context_id = NEW.context_id;

  IF NOT FOUND OR NOT (
    (
      command_scope.source_route_id = NEW.route_id
      AND command_scope.source_thread_id = NEW.thread_id
    )
    OR (
      command_scope.result_route_id IS NOT NULL
      AND command_scope.result_route_id = NEW.route_id
      AND command_scope.result_thread_id = NEW.thread_id
    )
  ) THEN
    RAISE EXCEPTION 'workflow output command scope is invalid'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_interrupts_origin_command_causal_scope
BEFORE INSERT OR UPDATE ON workflow_interrupts
FOR EACH ROW EXECUTE FUNCTION validate_workflow_command_causal_scope('originating_command_id');

CREATE TRIGGER workflow_messages_command_causal_scope
BEFORE INSERT OR UPDATE ON workflow_messages
FOR EACH ROW EXECUTE FUNCTION validate_workflow_command_causal_scope('command_id');

CREATE TRIGGER workflow_artifacts_command_causal_scope
BEFORE INSERT OR UPDATE ON workflow_artifacts
FOR EACH ROW EXECUTE FUNCTION validate_workflow_command_causal_scope('command_id');

CREATE TRIGGER memory_proposals_command_causal_scope
BEFORE INSERT OR UPDATE ON memory_proposals
FOR EACH ROW EXECUTE FUNCTION validate_workflow_command_causal_scope('command_id');

CREATE INDEX workflow_threads_route_updated_idx
  ON workflow_threads (route_id, status, updated_at DESC, id);

WITH ranked_conversations AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY route_id
      ORDER BY updated_at DESC, id
    ) AS route_position
  FROM workflow_threads
  WHERE status <> 'archived'
)
UPDATE workflow_threads conversation
SET is_primary = ranked_conversations.route_position = 1
FROM ranked_conversations
WHERE conversation.id = ranked_conversations.id;

CREATE UNIQUE INDEX workflow_threads_one_primary_per_route
  ON workflow_threads (route_id)
  WHERE is_primary AND status <> 'archived';

CREATE UNIQUE INDEX workflow_interrupts_one_pending_per_thread
  ON workflow_interrupts (context_id, route_id, thread_id)
  WHERE status = 'pending';

CREATE TABLE memory_items (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  context_id uuid,
  memory_key text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  current_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_items_context_owner_fk
    FOREIGN KEY (context_id, user_id)
    REFERENCES contexts(id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT memory_items_scope_valid
    CHECK (scope IN ('user', 'context')),
  CONSTRAINT memory_items_scope_context_valid CHECK (
    (scope = 'user' AND context_id IS NULL)
    OR (scope = 'context' AND context_id IS NOT NULL)
  ),
  CONSTRAINT memory_items_key_valid
    CHECK (char_length(memory_key) BETWEEN 1 AND 200),
  CONSTRAINT memory_items_status_valid
    CHECK (status IN ('active', 'invalidated')),
  CONSTRAINT memory_items_current_version_valid
    CHECK (current_version >= 1),
  CONSTRAINT memory_items_id_user_unique
    UNIQUE (id, user_id),
  CONSTRAINT memory_items_scope_key_unique
    UNIQUE NULLS NOT DISTINCT (user_id, scope, context_id, memory_key)
);

CREATE TABLE memory_item_versions (
  id uuid PRIMARY KEY,
  memory_id uuid NOT NULL,
  version integer NOT NULL,
  value jsonb,
  status text NOT NULL,
  source jsonb NOT NULL,
  evidence jsonb NOT NULL,
  impact_scope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_item_versions_memory_fk
    FOREIGN KEY (memory_id)
    REFERENCES memory_items(id)
    ON DELETE CASCADE,
  CONSTRAINT memory_item_versions_version_valid
    CHECK (version >= 1),
  CONSTRAINT memory_item_versions_status_valid
    CHECK (status IN ('active', 'invalidated')),
  CONSTRAINT memory_item_versions_source_valid
    CHECK (jsonb_typeof(source) = 'object'),
  CONSTRAINT memory_item_versions_evidence_valid
    CHECK (jsonb_typeof(evidence) = 'array'),
  CONSTRAINT memory_item_versions_impact_scope_valid
    CHECK (jsonb_typeof(impact_scope) = 'object'),
  CONSTRAINT memory_item_versions_memory_version_unique
    UNIQUE (memory_id, version),
  CONSTRAINT memory_item_versions_current_unique
    UNIQUE (memory_id, version, status)
);

ALTER TABLE memory_items
  ADD CONSTRAINT memory_items_current_version_fk
    FOREIGN KEY (id, current_version, status)
    REFERENCES memory_item_versions(memory_id, version, status)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION validate_memory_item_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.scope IS DISTINCT FROM NEW.scope
    OR OLD.context_id IS DISTINCT FROM NEW.context_id
    OR OLD.memory_key IS DISTINCT FROM NEW.memory_key
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'memory item identity is immutable' USING ERRCODE = '55000';
  END IF;

  -- No-op and updated_at-only writes are allowed. Any semantic status change
  -- must accompany exactly one new version, whose status is enforced by the
  -- deferred current-version foreign key.
  IF NEW.current_version = OLD.current_version THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'memory item status requires a new version' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.current_version <> OLD.current_version + 1 THEN
    RAISE EXCEPTION 'memory item version must advance by one' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER memory_items_versioned_update
BEFORE UPDATE ON memory_items
FOR EACH ROW EXECUTE FUNCTION validate_memory_item_transition();

CREATE INDEX memory_items_user_updated_idx
  ON memory_items (user_id, scope, status, updated_at DESC, id);

CREATE INDEX memory_items_context_updated_idx
  ON memory_items (context_id, status, updated_at DESC, id)
  WHERE scope = 'context';

CREATE INDEX memory_item_versions_history_idx
  ON memory_item_versions (memory_id, version DESC);

CREATE TRIGGER memory_item_versions_append_only
BEFORE UPDATE OR DELETE ON memory_item_versions
FOR EACH ROW EXECUTE FUNCTION reject_workflow_append_only_mutation();

CREATE TABLE staged_attachments (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_id uuid NOT NULL,
  filename text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  adopted_command_id uuid,
  adopted_context_id uuid,
  adopted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staged_attachments_object_owner_fk
    FOREIGN KEY (object_id, user_id)
    REFERENCES asset_objects(id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT staged_attachments_adopted_command_scope_fk
    FOREIGN KEY (adopted_command_id, adopted_context_id)
    REFERENCES workflow_commands(id, context_id)
    ON DELETE RESTRICT,
  CONSTRAINT staged_attachments_adopted_context_owner_fk
    FOREIGN KEY (adopted_context_id, user_id)
    REFERENCES contexts(id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT staged_attachments_filename_valid
    CHECK (char_length(filename) BETWEEN 1 AND 255),
  CONSTRAINT staged_attachments_status_valid
    CHECK (status IN ('pending', 'adopted')),
  CONSTRAINT staged_attachments_state_valid CHECK (
    (
      status = 'pending'
      AND adopted_command_id IS NULL
      AND adopted_context_id IS NULL
      AND adopted_at IS NULL
    )
    OR (
      status = 'adopted'
      AND adopted_command_id IS NOT NULL
      AND adopted_context_id IS NOT NULL
      AND adopted_at IS NOT NULL
    )
  ),
  CONSTRAINT staged_attachments_id_user_unique
    UNIQUE (id, user_id)
);

CREATE INDEX staged_attachments_user_status_idx
  ON staged_attachments (user_id, status, created_at DESC, id);

CREATE OR REPLACE FUNCTION validate_staged_attachment_adoption()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending'
      OR NEW.adopted_command_id IS NOT NULL
      OR NEW.adopted_context_id IS NOT NULL
      OR NEW.adopted_at IS NOT NULL THEN
      RAISE EXCEPTION 'staged attachments must be inserted pending'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'adopted staged attachments cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'pending' OR NEW.status <> 'adopted' THEN
    RAISE EXCEPTION 'staged attachment adoption is final' USING ERRCODE = '55000';
  END IF;

  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.object_id IS DISTINCT FROM NEW.object_id
    OR OLD.filename IS DISTINCT FROM NEW.filename
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'staged attachment ownership is immutable' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER staged_attachments_adopt_once
BEFORE INSERT OR UPDATE OR DELETE ON staged_attachments
FOR EACH ROW EXECUTE FUNCTION validate_staged_attachment_adoption();

-- workflow_checkpoints_immutable, created by 0002_workflow_domain, continues
-- to reject every snapshot UPDATE or row DELETE with SQLSTATE 55000.
