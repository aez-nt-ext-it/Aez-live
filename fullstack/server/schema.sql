CREATE TABLE IF NOT EXISTS users (
  email text PRIMARY KEY CHECK (email = lower(email)), name text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}', admin boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS profiles (
  email text REFERENCES users(email), role text CHECK(role IN ('emp','teach')),
  version integer NOT NULL DEFAULT 0, state jsonb NOT NULL DEFAULT '{"status":"Offline"}',
  PRIMARY KEY(email,role)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY, email text REFERENCES users(email), expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY, email text REFERENCES users(email), role text NOT NULL,
  action text NOT NULL, at timestamptz NOT NULL, data jsonb NOT NULL,
  before_state jsonb NOT NULL, after_version integer NOT NULL,
  undone boolean NOT NULL DEFAULT false, request_id uuid UNIQUE
);
CREATE INDEX IF NOT EXISTS events_report_idx ON events(email,role,at);
CREATE TABLE IF NOT EXISTS notifications (
  id bigserial PRIMARY KEY, email text NOT NULL, name text NOT NULL, role text NOT NULL,
  action text NOT NULL, event_type text NOT NULL, at timestamptz NOT NULL,
  event_id uuid REFERENCES events(id)
);
CREATE TABLE IF NOT EXISTS proofs (
  id uuid PRIMARY KEY, email text REFERENCES users(email), name text NOT NULL,
  mime text NOT NULL, bytes bytea NOT NULL, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mail_jobs (
  day date PRIMARY KEY, state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now(), last_error text, sent_at timestamptz
);
CREATE TABLE IF NOT EXISTS imported_records (
  id text PRIMARY KEY, kind text NOT NULL, email text, data jsonb NOT NULL, imported_at timestamptz DEFAULT now()
);
