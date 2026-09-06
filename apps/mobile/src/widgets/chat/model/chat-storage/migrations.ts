export const LEGACY_SCHEMA = `
      CREATE TABLE IF NOT EXISTS conversations (
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        local_id TEXT NOT NULL,
        server_id TEXT,
        title TEXT NOT NULL,
        engine TEXT NOT NULL,
        model TEXT NOT NULL,
        runtime_json TEXT,
        updated_at TEXT NOT NULL,
        last_viewed_at INTEGER NOT NULL,
        provisional INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, workspace_id, local_id),
        UNIQUE (user_id, workspace_id, server_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        local_id TEXT NOT NULL,
        server_id TEXT,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        parts_json TEXT NOT NULL DEFAULT '[]',
        delivery TEXT NOT NULL CHECK (delivery IN ('queued', 'sending', 'accepted', 'failed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, workspace_id, local_id),
        UNIQUE (user_id, workspace_id, server_id),
        FOREIGN KEY (user_id, workspace_id, conversation_id)
          REFERENCES conversations(user_id, workspace_id, local_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_idx
        ON messages(user_id, workspace_id, conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS drafts (
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        text TEXT NOT NULL,
        model_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, workspace_id, conversation_id)
      );
      CREATE TABLE IF NOT EXISTS attachments (
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        local_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        owner_kind TEXT NOT NULL CHECK (owner_kind IN ('draft', 'command')),
        owner_id TEXT NOT NULL,
        uri TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        validation_state TEXT NOT NULL,
        upload_generation INTEGER NOT NULL DEFAULT 0,
        server_attachment_id TEXT,
        expires_at TEXT,
        PRIMARY KEY (user_id, workspace_id, local_id)
      );
      CREATE INDEX IF NOT EXISTS attachments_owner_idx
        ON attachments(user_id, workspace_id, owner_kind, owner_id);
      CREATE TABLE IF NOT EXISTS outbox (
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('stop', 'approval', 'message')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'in_flight')),
        conversation_id TEXT NOT NULL,
        client_message_id TEXT,
        run_id TEXT,
        approval_id TEXT,
        intent_json TEXT NOT NULL,
        frozen_body_json TEXT,
        idempotency_key TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, workspace_id, id)
      );
      CREATE INDEX IF NOT EXISTS outbox_drain_idx
        ON outbox(user_id, workspace_id, status, next_attempt_at, kind, created_at);
      CREATE TABLE IF NOT EXISTS run_checkpoints (
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        parts_json TEXT NOT NULL DEFAULT '[]',
        durable_cursor TEXT,
        presentation_cursor TEXT,
        is_stopping INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, workspace_id, run_id),
        FOREIGN KEY (user_id, workspace_id, conversation_id)
          REFERENCES conversations(user_id, workspace_id, local_id) ON DELETE CASCADE
      );
      PRAGMA user_version = 1;
    `;

export const SINGLE_ID_SCHEMA = `
CREATE TABLE conversations_v2 (
  user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, local_id TEXT NOT NULL,
  title TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL, runtime_json TEXT,
  updated_at TEXT NOT NULL, last_viewed_at INTEGER NOT NULL, provisional INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, workspace_id, local_id)
);
INSERT INTO conversations_v2 SELECT user_id, workspace_id, local_id, title, engine, model,
  runtime_json, updated_at, last_viewed_at, provisional FROM conversations;
CREATE TABLE messages_v2 (
  user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, local_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL, parts_json TEXT NOT NULL DEFAULT '[]',
  delivery TEXT NOT NULL CHECK(delivery IN ('queued','sending','accepted')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, workspace_id, local_id),
  FOREIGN KEY (user_id, workspace_id, conversation_id)
    REFERENCES conversations(user_id, workspace_id, local_id) ON DELETE CASCADE
);
INSERT INTO messages_v2 SELECT m.user_id, m.workspace_id, m.local_id, m.conversation_id, m.role,
  COALESCE(r.content, m.content), COALESCE(r.parts_json, m.parts_json),
  CASE WHEN m.delivery = 'failed' THEN 'queued' ELSE m.delivery END, m.created_at, m.updated_at
  FROM messages m LEFT JOIN run_checkpoints r ON r.user_id = m.user_id
    AND r.workspace_id = m.workspace_id AND r.assistant_message_id = m.local_id;
DROP TABLE messages;
DROP TABLE conversations;
ALTER TABLE conversations_v2 RENAME TO conversations;
ALTER TABLE messages_v2 RENAME TO messages;
CREATE INDEX messages_conversation_idx ON messages(user_id, workspace_id, conversation_id, created_at);
ALTER TABLE attachments DROP COLUMN validation_state;
ALTER TABLE run_checkpoints DROP COLUMN content;
ALTER TABLE run_checkpoints DROP COLUMN parts_json;
PRAGMA user_version = 2;
`;
