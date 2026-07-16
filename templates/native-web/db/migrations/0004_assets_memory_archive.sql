ALTER TABLE contexts
  ADD CONSTRAINT contexts_id_user_unique UNIQUE (id, user_id);

CREATE TABLE asset_objects (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  byte_size bigint NOT NULL,
  media_type text NOT NULL,
  status text NOT NULL DEFAULT 'ready',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_objects_storage_key_unique UNIQUE (storage_key),
  CONSTRAINT asset_objects_user_hash_size_unique UNIQUE (user_id, sha256, byte_size),
  CONSTRAINT asset_objects_id_user_unique UNIQUE (id, user_id),
  CONSTRAINT asset_objects_hash_valid CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT asset_objects_size_valid CHECK (byte_size >= 0 AND byte_size <= 26214400),
  CONSTRAINT asset_objects_media_type_valid CHECK (char_length(media_type) BETWEEN 1 AND 200),
  CONSTRAINT asset_objects_status_valid CHECK (status IN ('pending', 'ready', 'failed'))
);

CREATE INDEX asset_objects_user_created_idx ON asset_objects (user_id, created_at DESC, id);

CREATE TABLE workflow_attachments (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  object_id uuid NOT NULL,
  context_id uuid NOT NULL,
  route_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  stage_key text NOT NULL,
  filename text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_attachments_owner_fk
    FOREIGN KEY (context_id, user_id) REFERENCES contexts(id, user_id) ON DELETE CASCADE,
  CONSTRAINT workflow_attachments_object_owner_fk
    FOREIGN KEY (object_id, user_id) REFERENCES asset_objects(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT workflow_attachments_thread_scope_fk
    FOREIGN KEY (thread_id, context_id, route_id, stage_key)
    REFERENCES workflow_threads(id, context_id, route_id, stage_key) ON DELETE CASCADE,
  CONSTRAINT workflow_attachments_filename_valid CHECK (char_length(filename) BETWEEN 1 AND 255),
  CONSTRAINT workflow_attachments_id_user_unique UNIQUE (id, user_id)
);

CREATE INDEX workflow_attachments_thread_created_idx
  ON workflow_attachments (thread_id, created_at DESC, id);

CREATE TABLE workflow_artifacts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  object_id uuid,
  command_id uuid NOT NULL,
  context_id uuid NOT NULL,
  route_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  stage_key text NOT NULL,
  filename text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_artifacts_owner_fk
    FOREIGN KEY (context_id, user_id) REFERENCES contexts(id, user_id) ON DELETE CASCADE,
  CONSTRAINT workflow_artifacts_object_owner_fk
    FOREIGN KEY (object_id, user_id) REFERENCES asset_objects(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT workflow_artifacts_command_fk
    FOREIGN KEY (command_id) REFERENCES workflow_commands(id) ON DELETE RESTRICT,
  CONSTRAINT workflow_artifacts_thread_scope_fk
    FOREIGN KEY (thread_id, context_id, route_id, stage_key)
    REFERENCES workflow_threads(id, context_id, route_id, stage_key) ON DELETE RESTRICT,
  CONSTRAINT workflow_artifacts_filename_valid CHECK (char_length(filename) BETWEEN 1 AND 255),
  CONSTRAINT workflow_artifacts_status_valid CHECK (status IN ('pending', 'ready', 'failed')),
  CONSTRAINT workflow_artifacts_state_valid CHECK (
    (status = 'ready' AND object_id IS NOT NULL AND error_code IS NULL)
    OR (status = 'pending' AND object_id IS NULL AND error_code IS NULL)
    OR (status = 'failed' AND object_id IS NULL AND error_code IS NOT NULL)
  )
);

CREATE INDEX workflow_artifacts_thread_created_idx
  ON workflow_artifacts (thread_id, created_at DESC, id);

CREATE TABLE memory_proposals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  command_id uuid NOT NULL REFERENCES workflow_commands(id) ON DELETE RESTRICT,
  context_id uuid NOT NULL,
  route_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  stage_key text NOT NULL,
  scope text NOT NULL,
  proposal_key text NOT NULL,
  proposal_value jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_proposals_owner_fk
    FOREIGN KEY (context_id, user_id) REFERENCES contexts(id, user_id) ON DELETE CASCADE,
  CONSTRAINT memory_proposals_command_fk
    FOREIGN KEY (command_id) REFERENCES workflow_commands(id) ON DELETE RESTRICT,
  CONSTRAINT memory_proposals_thread_scope_fk
    FOREIGN KEY (thread_id, context_id, route_id, stage_key)
    REFERENCES workflow_threads(id, context_id, route_id, stage_key) ON DELETE RESTRICT,
  CONSTRAINT memory_proposals_scope_valid CHECK (scope IN ('user', 'context', 'route', 'stage', 'thread')),
  CONSTRAINT memory_proposals_key_valid CHECK (char_length(proposal_key) BETWEEN 1 AND 200),
  CONSTRAINT memory_proposals_value_valid CHECK (jsonb_typeof(proposal_value) IN ('string', 'number', 'boolean', 'null')),
  CONSTRAINT memory_proposals_status_valid CHECK (status IN ('pending', 'adopted', 'rejected')),
  CONSTRAINT memory_proposals_decision_valid CHECK (
    (status = 'pending' AND decided_at IS NULL) OR
    (status IN ('adopted', 'rejected') AND decided_at IS NOT NULL)
  ),
  CONSTRAINT memory_proposals_id_user_unique UNIQUE (id, user_id)
);

CREATE INDEX memory_proposals_user_status_idx
  ON memory_proposals (user_id, status, created_at DESC, id);

CREATE OR REPLACE FUNCTION validate_memory_proposal_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'pending' OR NEW.status = 'pending' OR NEW.decided_at IS NULL THEN
    RAISE EXCEPTION 'memory proposal decisions are final' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.command_id IS DISTINCT FROM NEW.command_id OR OLD.context_id IS DISTINCT FROM NEW.context_id
    OR OLD.route_id IS DISTINCT FROM NEW.route_id OR OLD.thread_id IS DISTINCT FROM NEW.thread_id
    OR OLD.stage_key IS DISTINCT FROM NEW.stage_key OR OLD.scope IS DISTINCT FROM NEW.scope
    OR OLD.proposal_key IS DISTINCT FROM NEW.proposal_key OR OLD.proposal_value IS DISTINCT FROM NEW.proposal_value
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'memory proposal content is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER memory_proposals_decision_once
BEFORE UPDATE ON memory_proposals
FOR EACH ROW EXECUTE FUNCTION validate_memory_proposal_decision();

CREATE TABLE memory_entries (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL,
  scope text NOT NULL,
  context_id uuid,
  route_id uuid,
  thread_id uuid,
  stage_key text,
  entry_key text NOT NULL,
  entry_value jsonb NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_entries_proposal_owner_fk
    FOREIGN KEY (proposal_id, user_id) REFERENCES memory_proposals(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT memory_entries_proposal_unique UNIQUE (proposal_id),
  CONSTRAINT memory_entries_scope_valid CHECK (scope IN ('user', 'context', 'route', 'stage', 'thread')),
  CONSTRAINT memory_entries_value_valid CHECK (jsonb_typeof(entry_value) IN ('string', 'number', 'boolean', 'null')),
  CONSTRAINT memory_entries_version_valid CHECK (version >= 1),
  CONSTRAINT memory_entries_scope_fields_valid CHECK (
    (scope = 'user' AND context_id IS NULL AND route_id IS NULL AND thread_id IS NULL AND stage_key IS NULL)
    OR (scope = 'context' AND context_id IS NOT NULL AND route_id IS NULL AND thread_id IS NULL AND stage_key IS NULL)
    OR (scope = 'route' AND context_id IS NOT NULL AND route_id IS NOT NULL AND thread_id IS NULL AND stage_key IS NULL)
    OR (scope = 'stage' AND context_id IS NOT NULL AND route_id IS NOT NULL AND thread_id IS NULL AND stage_key IS NOT NULL)
    OR (scope = 'thread' AND context_id IS NOT NULL AND route_id IS NOT NULL AND thread_id IS NOT NULL AND stage_key IS NOT NULL)
  ),
  CONSTRAINT memory_entries_scope_version_unique
    UNIQUE NULLS NOT DISTINCT (user_id, scope, context_id, route_id, thread_id, stage_key, entry_key, version)
);

CREATE TABLE librechat_archive_conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_conversation_id text NOT NULL,
  title text NOT NULL,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now(),
  read_only boolean NOT NULL DEFAULT true,
  CONSTRAINT librechat_archive_conversations_source_unique UNIQUE (user_id, source_conversation_id),
  CONSTRAINT librechat_archive_conversations_id_user_unique UNIQUE (id, user_id),
  CONSTRAINT librechat_archive_conversations_title_valid CHECK (char_length(title) BETWEEN 1 AND 300),
  CONSTRAINT librechat_archive_conversations_read_only CHECK (read_only)
);

CREATE INDEX librechat_archive_conversations_user_updated_idx
  ON librechat_archive_conversations (user_id, source_updated_at DESC NULLS LAST, id);

CREATE TABLE librechat_archive_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  source_message_id text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  source_created_at timestamptz,
  sequence integer NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT librechat_archive_messages_conversation_owner_fk
    FOREIGN KEY (conversation_id, user_id)
    REFERENCES librechat_archive_conversations(id, user_id) ON DELETE CASCADE,
  CONSTRAINT librechat_archive_messages_source_unique UNIQUE (user_id, source_message_id),
  CONSTRAINT librechat_archive_messages_conversation_sequence_unique UNIQUE (conversation_id, sequence),
  CONSTRAINT librechat_archive_messages_role_valid CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  CONSTRAINT librechat_archive_messages_sequence_valid CHECK (sequence >= 1)
);

CREATE TABLE librechat_archive_attachments (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  message_id uuid,
  user_id uuid NOT NULL,
  object_id uuid,
  source_attachment_id text NOT NULL,
  filename text NOT NULL,
  expected_sha256 text,
  status text NOT NULL,
  error_code text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT librechat_archive_attachments_conversation_owner_fk
    FOREIGN KEY (conversation_id, user_id)
    REFERENCES librechat_archive_conversations(id, user_id) ON DELETE CASCADE,
  CONSTRAINT librechat_archive_attachments_message_fk
    FOREIGN KEY (message_id) REFERENCES librechat_archive_messages(id) ON DELETE CASCADE,
  CONSTRAINT librechat_archive_attachments_object_owner_fk
    FOREIGN KEY (object_id, user_id) REFERENCES asset_objects(id, user_id) ON DELETE RESTRICT,
  CONSTRAINT librechat_archive_attachments_source_unique UNIQUE (user_id, source_attachment_id),
  CONSTRAINT librechat_archive_attachments_filename_valid CHECK (char_length(filename) BETWEEN 1 AND 255),
  CONSTRAINT librechat_archive_attachments_hash_valid CHECK (expected_sha256 IS NULL OR expected_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT librechat_archive_attachments_status_valid CHECK (status IN ('ready', 'missing', 'hash_mismatch')),
  CONSTRAINT librechat_archive_attachments_state_valid CHECK (
    (status = 'ready' AND object_id IS NOT NULL AND error_code IS NULL)
    OR (status IN ('missing', 'hash_mismatch') AND object_id IS NULL AND error_code IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION reject_native_archive_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER workflow_attachments_immutable
BEFORE UPDATE OR DELETE ON workflow_attachments
FOR EACH ROW EXECUTE FUNCTION reject_native_archive_mutation();

CREATE TRIGGER workflow_artifacts_immutable
BEFORE UPDATE OR DELETE ON workflow_artifacts
FOR EACH ROW EXECUTE FUNCTION reject_native_archive_mutation();

CREATE TRIGGER memory_entries_immutable
BEFORE UPDATE OR DELETE ON memory_entries
FOR EACH ROW EXECUTE FUNCTION reject_native_archive_mutation();

CREATE TRIGGER memory_proposals_no_delete
BEFORE DELETE ON memory_proposals
FOR EACH ROW EXECUTE FUNCTION reject_native_archive_mutation();

CREATE TRIGGER librechat_archive_conversations_immutable
BEFORE UPDATE OR DELETE ON librechat_archive_conversations
FOR EACH ROW EXECUTE FUNCTION reject_native_archive_mutation();

CREATE TRIGGER librechat_archive_messages_immutable
BEFORE UPDATE OR DELETE ON librechat_archive_messages
FOR EACH ROW EXECUTE FUNCTION reject_native_archive_mutation();

CREATE TRIGGER librechat_archive_attachments_immutable
BEFORE UPDATE OR DELETE ON librechat_archive_attachments
FOR EACH ROW EXECUTE FUNCTION reject_native_archive_mutation();
