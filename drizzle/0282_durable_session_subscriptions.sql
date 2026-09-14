CREATE TABLE goat.session_subscriptions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES goat.chat_sessions(id) ON DELETE CASCADE,
  integration_id text NOT NULL REFERENCES goat.integrations(id) ON DELETE CASCADE,
  source text NOT NULL,
  source_key jsonb NOT NULL,
  policy jsonb NOT NULL DEFAULT '{"acceptedEvents":["human_text_reply"],"authorization":"workspace_member","queue":"serial"}',
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'closed')),
  next_sequence bigint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX session_subscriptions_source_idx ON goat.session_subscriptions(workspace_id, source, source_key);
CREATE INDEX session_subscriptions_session_idx ON goat.session_subscriptions(session_id);
--> statement-breakpoint
CREATE TABLE goat.subscription_events (
  id bigserial PRIMARY KEY,
  subscription_id text NOT NULL REFERENCES goat.session_subscriptions(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  sequence bigint NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'delivering', 'done', 'ignored')),
  run_id text REFERENCES goat.codex_chat_turns(id),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscription_events_event_idx ON goat.subscription_events(subscription_id, event_id);
CREATE UNIQUE INDEX subscription_events_sequence_idx ON goat.subscription_events(subscription_id, sequence);
CREATE INDEX subscription_events_pending_idx ON goat.subscription_events(status, id);
--> statement-breakpoint
CREATE TABLE goat.channel_deliveries (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES goat.chat_sessions(id) ON DELETE CASCADE,
  integration_id text NOT NULL REFERENCES goat.integrations(id) ON DELETE CASCADE,
  team_id text NOT NULL,
  channel_id text NOT NULL,
  thread_ts text,
  text text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'uncertain', 'failed', 'canceled')),
  message_ts text,
  lease_id text,
  lease_expires_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channel_deliveries_pending_idx ON goat.channel_deliveries(status, created_at);
