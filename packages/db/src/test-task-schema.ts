export const TASK_TEST_BASE_SCHEMA = `
  CREATE SCHEMA goat;
  CREATE SEQUENCE goat.task_display_id_seq;
  CREATE TABLE goat.users (workos_user_id text PRIMARY KEY);
  CREATE TABLE goat.workspaces (id text PRIMARY KEY);
  CREATE TABLE goat.workspace_members (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    user_workos_id text NOT NULL,
    role text NOT NULL
  );
  CREATE TABLE goat.chat_sessions (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    title text NOT NULL DEFAULT 'New chat',
    model text NOT NULL,
    engine text NOT NULL DEFAULT 'opencompany',
    kind text NOT NULL DEFAULT 'chat',
    closed_at timestamptz,
    pinned_at timestamptz,
    last_seen_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.tasks (
    id text PRIMARY KEY,
    display_id text NOT NULL DEFAULT ('TASK-' || nextval('goat.task_display_id_seq')::text),
    name text NOT NULL DEFAULT 'Untitled task',
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    workspace_id text REFERENCES goat.workspaces(id),
    prompt text NOT NULL,
    model text NOT NULL,
    session_id text REFERENCES goat.chat_sessions(id),
    schedule_id text,
    scheduled_for timestamptz,
    status text NOT NULL DEFAULT 'queued',
    stage text NOT NULL DEFAULT 'queued',
    result text,
      error text,
      workflow_id text,
      agent_id text,
      reported_outcome text,
    outcome_comment text,
    harness_spec jsonb NOT NULL DEFAULT '{}'::jsonb,
    debug_trace jsonb NOT NULL DEFAULT '{}'::jsonb,
    codex_engine_session_id text,
    sandbox_id text,
    attempts integer NOT NULL DEFAULT 0,
    next_run_at timestamptz NOT NULL DEFAULT now(),
    lease_id text,
    lease_owner text,
    lease_expires_at timestamptz,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE goat.tasks ADD CONSTRAINT goat_tasks_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled'));
  CREATE UNIQUE INDEX goat_tasks_session_idx ON goat.tasks(session_id) WHERE session_id IS NOT NULL;
  CREATE TABLE goat.task_messages (
    id text PRIMARY KEY,
    task_id text NOT NULL REFERENCES goat.tasks(id),
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    role text NOT NULL,
    status text NOT NULL,
    content text NOT NULL DEFAULT '',
    tool_name text,
    tool_call_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
  );
  CREATE TABLE goat.task_events (
    id serial PRIMARY KEY,
    task_id text NOT NULL REFERENCES goat.tasks(id),
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    message_id text REFERENCES goat.task_messages(id),
    type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.task_model_usage (
    id serial PRIMARY KEY,
    task_id text NOT NULL REFERENCES goat.tasks(id),
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    total_cost_usd_micros bigint NOT NULL DEFAULT 0
  );
  CREATE TABLE goat.task_tool_usage (
    id serial PRIMARY KEY,
    task_id text NOT NULL REFERENCES goat.tasks(id),
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    total_cost_usd_micros bigint NOT NULL DEFAULT 0
  );
  CREATE TABLE goat.task_sandbox_usage (
    id serial PRIMARY KEY,
    task_id text NOT NULL REFERENCES goat.tasks(id),
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    total_cost_usd_micros bigint NOT NULL DEFAULT 0
  );
  CREATE TABLE goat.chat_messages (
    id text PRIMARY KEY,
    session_id text NOT NULL REFERENCES goat.chat_sessions(id),
    role text NOT NULL,
    content text NOT NULL DEFAULT '',
    task_id text,
    debug_trace jsonb,
    attachments jsonb,
    attachment_texts jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.credit_ledger (
    id serial PRIMARY KEY,
    user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id),
    chat_session_id text REFERENCES goat.chat_sessions(id),
    amount_usd_micros bigint NOT NULL
  );
  CREATE TABLE goat.codex_chat_sessions (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    chat_session_id text NOT NULL UNIQUE REFERENCES goat.chat_sessions(id),
    engine text NOT NULL DEFAULT 'codex',
    model text NOT NULL,
    workspace_id text,
    host_tool_contract_version text,
    execution_backend text NOT NULL DEFAULT 'runner_attached',
    execution_backend_version integer NOT NULL DEFAULT 1,
    supervisor_template_version text,
    sandbox_id text,
    codex_thread_id text,
    active_turn_id text,
    status text NOT NULL DEFAULT 'queued',
    error text,
    sandbox_timeout_armed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.codex_chat_turns (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    codex_chat_session_id text NOT NULL REFERENCES goat.codex_chat_sessions(id),
    chat_session_id text NOT NULL REFERENCES goat.chat_sessions(id),
    user_message_id text NOT NULL REFERENCES goat.chat_messages(id),
    assistant_message_id text NOT NULL UNIQUE REFERENCES goat.chat_messages(id),
    codex_turn_id text,
    status text NOT NULL DEFAULT 'queued',
    prompt text NOT NULL,
    settings jsonb NOT NULL DEFAULT '{}',
    execution_backend text NOT NULL DEFAULT 'runner_attached',
    execution_backend_version integer NOT NULL DEFAULT 1,
    error text,
    interrupt_requested_at timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    recovery_attempts integer NOT NULL DEFAULT 0,
    engine_recovery_required boolean NOT NULL DEFAULT false,
    engine_turn_baseline_ids jsonb,
    lease_id text,
    lease_owner text,
    lease_expires_at timestamptz,
    run_after timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE goat.codex_chat_interactions (
    id text PRIMARY KEY,
    user_workos_id text NOT NULL,
    codex_chat_session_id text NOT NULL,
    codex_chat_turn_id text NOT NULL,
    lease_id text NOT NULL,
    request_id text NOT NULL,
    item_id text,
    method text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    request jsonb NOT NULL,
    response jsonb,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;
