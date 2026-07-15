CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  email_normalized text NOT NULL,
  username text NOT NULL,
  username_normalized text NOT NULL,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  created_via text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_normalized_unique UNIQUE (email_normalized),
  CONSTRAINT users_username_normalized_unique UNIQUE (username_normalized),
  CONSTRAINT users_status_valid CHECK (status IN ('active', 'disabled')),
  CONSTRAINT users_created_via_valid CHECK (created_via IN ('registration', 'admin_cli'))
);

CREATE TABLE email_verifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_digest text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  sent_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_verifications_attempt_count_valid CHECK (
    attempt_count >= 0 AND attempt_count <= 5
  ),
  CONSTRAINT email_verifications_expiry_valid CHECK (expires_at > sent_at)
);

CREATE UNIQUE INDEX email_verifications_one_active_per_user
  ON email_verifications (user_id)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE INDEX email_verifications_user_created_idx
  ON email_verifications (user_id, created_at DESC);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent text,
  ip_prefix text,
  CONSTRAINT auth_sessions_token_digest_unique UNIQUE (token_digest),
  CONSTRAINT auth_sessions_expiry_valid CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at)
  WHERE revoked_at IS NULL;
