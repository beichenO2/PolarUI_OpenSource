ALTER TABLE staged_attachments
  ADD COLUMN claimed_command_id uuid,
  ADD COLUMN claimed_context_id uuid,
  ADD CONSTRAINT staged_attachments_claimed_command_scope_fk
    FOREIGN KEY (claimed_command_id, claimed_context_id)
    REFERENCES workflow_commands(id, context_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT staged_attachments_claimed_context_owner_fk
    FOREIGN KEY (claimed_context_id, user_id)
    REFERENCES contexts(id, user_id)
    ON DELETE RESTRICT;

ALTER TABLE staged_attachments
  DROP CONSTRAINT staged_attachments_state_valid,
  ADD CONSTRAINT staged_attachments_state_valid CHECK (
    (
      status = 'pending'
      AND adopted_command_id IS NULL
      AND adopted_context_id IS NULL
      AND adopted_at IS NULL
      AND (
        (claimed_command_id IS NULL AND claimed_context_id IS NULL)
        OR (claimed_command_id IS NOT NULL AND claimed_context_id IS NOT NULL)
      )
    )
    OR (
      status = 'adopted'
      AND claimed_command_id IS NULL
      AND claimed_context_id IS NULL
      AND adopted_command_id IS NOT NULL
      AND adopted_context_id IS NOT NULL
      AND adopted_at IS NOT NULL
    )
  );

CREATE INDEX staged_attachments_claimed_command_idx
  ON staged_attachments (claimed_command_id)
  WHERE claimed_command_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_staged_attachment_adoption()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending'
      OR NEW.claimed_command_id IS NOT NULL
      OR NEW.claimed_context_id IS NOT NULL
      OR NEW.adopted_command_id IS NOT NULL
      OR NEW.adopted_context_id IS NOT NULL
      OR NEW.adopted_at IS NOT NULL THEN
      RAISE EXCEPTION 'staged attachments must be inserted pending and unclaimed'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'pending'
      OR OLD.claimed_command_id IS NOT NULL
      OR OLD.claimed_context_id IS NOT NULL THEN
      RAISE EXCEPTION 'claimed or adopted staged attachments cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.object_id IS DISTINCT FROM NEW.object_id
    OR OLD.filename IS DISTINCT FROM NEW.filename
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'staged attachment ownership is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'pending' THEN
    IF NEW.adopted_command_id IS NOT NULL
      OR NEW.adopted_context_id IS NOT NULL
      OR NEW.adopted_at IS NOT NULL THEN
      RAISE EXCEPTION 'pending staged attachments cannot have adoption metadata'
        USING ERRCODE = '55000';
    END IF;

    IF OLD.claimed_command_id IS NOT NULL
      AND NEW.claimed_command_id IS NOT NULL
      AND (
        OLD.claimed_command_id IS DISTINCT FROM NEW.claimed_command_id
        OR OLD.claimed_context_id IS DISTINCT FROM NEW.claimed_context_id
      ) THEN
      RAISE EXCEPTION 'staged attachment claims must be released before reassignment'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'adopted' THEN
    IF OLD.claimed_command_id IS NULL
      OR OLD.claimed_context_id IS NULL
      OR OLD.claimed_command_id IS DISTINCT FROM NEW.adopted_command_id
      OR OLD.claimed_context_id IS DISTINCT FROM NEW.adopted_context_id
      OR NEW.claimed_command_id IS NOT NULL
      OR NEW.claimed_context_id IS NOT NULL THEN
      RAISE EXCEPTION 'only the claiming command can adopt a staged attachment'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'staged attachment adoption is final' USING ERRCODE = '55000';
END;
$$;
