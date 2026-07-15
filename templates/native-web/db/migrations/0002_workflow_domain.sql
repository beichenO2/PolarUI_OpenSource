CREATE TABLE contexts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contexts_title_valid CHECK (char_length(title) BETWEEN 1 AND 120),
  CONSTRAINT contexts_status_valid CHECK (status IN ('active', 'archived'))
);

CREATE INDEX contexts_user_updated_idx ON contexts (user_id, updated_at DESC, id);

CREATE TABLE workflow_routes (
  id uuid PRIMARY KEY,
  context_id uuid NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
  name text NOT NULL,
  origin_checkpoint_id uuid,
  head_checkpoint_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_routes_name_valid CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT workflow_routes_id_context_unique UNIQUE (id, context_id)
);

CREATE INDEX workflow_routes_context_updated_idx
  ON workflow_routes (context_id, updated_at DESC, id);

CREATE TABLE workflow_checkpoints (
  id uuid PRIMARY KEY,
  context_id uuid NOT NULL,
  route_id uuid NOT NULL,
  parent_checkpoint_id uuid,
  version integer NOT NULL,
  stage_key text NOT NULL,
  reason text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_checkpoints_route_context_fk
    FOREIGN KEY (route_id, context_id)
    REFERENCES workflow_routes(id, context_id)
    ON DELETE CASCADE,
  CONSTRAINT workflow_checkpoints_version_valid CHECK (version >= 0),
  CONSTRAINT workflow_checkpoints_stage_key_valid CHECK (stage_key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT workflow_checkpoints_reason_valid CHECK (reason IN ('bootstrap', 'branch', 'workflow_action')),
  CONSTRAINT workflow_checkpoints_snapshot_valid CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT workflow_checkpoints_route_version_unique UNIQUE (route_id, version),
  CONSTRAINT workflow_checkpoints_id_route_context_unique UNIQUE (id, route_id, context_id),
  CONSTRAINT workflow_checkpoints_parent_scope_fk
    FOREIGN KEY (parent_checkpoint_id, route_id, context_id)
    REFERENCES workflow_checkpoints(id, route_id, context_id)
    ON DELETE RESTRICT
);

ALTER TABLE workflow_routes
  ADD CONSTRAINT workflow_routes_origin_checkpoint_fk
    FOREIGN KEY (origin_checkpoint_id)
    REFERENCES workflow_checkpoints(id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT workflow_routes_head_checkpoint_fk
    FOREIGN KEY (head_checkpoint_id)
    REFERENCES workflow_checkpoints(id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX workflow_checkpoints_route_created_idx
  ON workflow_checkpoints (route_id, version DESC);

CREATE TABLE route_stage_projections (
  route_id uuid NOT NULL REFERENCES workflow_routes(id) ON DELETE CASCADE,
  stage_key text NOT NULL,
  position integer NOT NULL,
  status text NOT NULL,
  internal_state text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (route_id, stage_key),
  CONSTRAINT route_stage_projections_position_valid CHECK (position >= 0),
  CONSTRAINT route_stage_projections_stage_key_valid CHECK (stage_key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT route_stage_projections_status_valid CHECK (status IN ('not_started', 'active', 'completed'))
);

CREATE UNIQUE INDEX route_stage_projections_position_unique
  ON route_stage_projections (route_id, position);

CREATE TABLE workflow_threads (
  id uuid PRIMARY KEY,
  context_id uuid NOT NULL,
  route_id uuid NOT NULL,
  stage_key text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_threads_route_context_fk
    FOREIGN KEY (route_id, context_id)
    REFERENCES workflow_routes(id, context_id)
    ON DELETE CASCADE,
  CONSTRAINT workflow_threads_route_stage_fk
    FOREIGN KEY (route_id, stage_key)
    REFERENCES route_stage_projections(route_id, stage_key)
    ON DELETE RESTRICT,
  CONSTRAINT workflow_threads_stage_key_valid CHECK (stage_key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT workflow_threads_title_valid CHECK (char_length(title) BETWEEN 1 AND 120),
  CONSTRAINT workflow_threads_status_valid CHECK (status IN ('active', 'archived'))
);

CREATE INDEX workflow_threads_route_stage_updated_idx
  ON workflow_threads (route_id, stage_key, status, updated_at DESC, id);

CREATE OR REPLACE FUNCTION reject_workflow_checkpoint_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'workflow checkpoints are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER workflow_checkpoints_immutable
BEFORE UPDATE OR DELETE ON workflow_checkpoints
FOR EACH ROW EXECUTE FUNCTION reject_workflow_checkpoint_mutation();

CREATE OR REPLACE FUNCTION validate_workflow_route_checkpoints()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_context_id uuid;
  current_head_checkpoint_id uuid;
  current_origin_checkpoint_id uuid;
BEGIN
  SELECT context_id, head_checkpoint_id, origin_checkpoint_id
  INTO current_context_id, current_head_checkpoint_id, current_origin_checkpoint_id
  FROM workflow_routes
  WHERE id = NEW.id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF current_head_checkpoint_id IS NULL THEN
    RAISE EXCEPTION 'route head checkpoint is required at transaction commit' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM workflow_checkpoints
    WHERE id = current_head_checkpoint_id
      AND route_id = NEW.id
      AND context_id = current_context_id
  ) THEN
    RAISE EXCEPTION 'route head checkpoint is outside route scope' USING ERRCODE = '23514';
  END IF;

  IF current_origin_checkpoint_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workflow_checkpoints
    WHERE id = current_origin_checkpoint_id
      AND context_id = current_context_id
  ) THEN
    RAISE EXCEPTION 'route origin checkpoint is outside context scope' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER workflow_routes_checkpoint_scope
AFTER INSERT OR UPDATE OF context_id, head_checkpoint_id, origin_checkpoint_id ON workflow_routes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_workflow_route_checkpoints();

CREATE OR REPLACE FUNCTION reject_workflow_route_origin_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.origin_checkpoint_id IS DISTINCT FROM NEW.origin_checkpoint_id THEN
    RAISE EXCEPTION 'route origin checkpoint is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_routes_origin_immutable
BEFORE UPDATE OF origin_checkpoint_id ON workflow_routes
FOR EACH ROW EXECUTE FUNCTION reject_workflow_route_origin_mutation();
