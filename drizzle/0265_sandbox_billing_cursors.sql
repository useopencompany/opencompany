CREATE TABLE goat.sandbox_billing_cursors (
  sandbox_id text PRIMARY KEY,
  namespace text NOT NULL,
  workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
  user_workos_id text NOT NULL REFERENCES goat.users(workos_user_id) ON DELETE CASCADE,
  billable_from timestamptz NOT NULL,
  provider_started_at timestamptz,
  settled_through timestamptz,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  missing_at timestamptz,
  CONSTRAINT sandbox_billing_cursors_interval_check CHECK (
    (provider_started_at IS NULL AND settled_through IS NULL)
    OR (provider_started_at IS NOT NULL AND settled_through IS NOT NULL
      AND settled_through >= provider_started_at AND settled_through >= billable_from)
  )
);
--> statement-breakpoint
CREATE INDEX sandbox_billing_cursors_due_idx
  ON goat.sandbox_billing_cursors(namespace, next_poll_at, sandbox_id)
  WHERE missing_at IS NULL;
