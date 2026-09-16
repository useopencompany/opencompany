CREATE TABLE goat.slack_direct_messages (
  id bigserial PRIMARY KEY,
  team_id text NOT NULL,
  event_id text NOT NULL,
  channel_id text NOT NULL,
  message_ts text NOT NULL,
  slack_user_id text NOT NULL,
  text text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CONSTRAINT slack_direct_messages_status_check CHECK (status IN ('pending', 'started', 'ignored')),
  session_id text REFERENCES goat.chat_sessions(id) ON DELETE SET NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX slack_direct_messages_event_idx ON goat.slack_direct_messages(team_id, event_id);
CREATE INDEX slack_direct_messages_pending_idx ON goat.slack_direct_messages(status, next_attempt_at, id) WHERE status = 'pending';
