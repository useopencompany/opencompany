-- Paid plugins: reviewed list prices on the installed package, a price snapshot on every
-- plugin-routed capability run, and a workspace-set daily spend ceiling per plugin.
ALTER TABLE goat.plugins ADD COLUMN IF NOT EXISTS pricing jsonb;
--> statement-breakpoint
ALTER TABLE goat.capability_runs ADD COLUMN IF NOT EXISTS plugin_name text;
--> statement-breakpoint
ALTER TABLE goat.capability_runs ADD COLUMN IF NOT EXISTS price_unit text;
--> statement-breakpoint
ALTER TABLE goat.capability_runs ADD COLUMN IF NOT EXISTS price_amount_usd_micros bigint;
--> statement-breakpoint
ALTER TABLE goat.capability_runs ADD COLUMN IF NOT EXISTS price_max_units integer;
--> statement-breakpoint
-- A plugin-routed run carries a complete price snapshot or none at all; a partial one cannot be
-- settled deterministically.
ALTER TABLE goat.capability_runs DROP CONSTRAINT IF EXISTS goat_capability_runs_plugin_price_check;
--> statement-breakpoint
ALTER TABLE goat.capability_runs ADD CONSTRAINT goat_capability_runs_plugin_price_check CHECK (
  (
    plugin_name IS NULL
    AND price_unit IS NULL
    AND price_amount_usd_micros IS NULL
    AND price_max_units IS NULL
  ) OR (
    plugin_name IS NOT NULL
    AND price_unit IN ('per_call', 'per_result')
    AND price_amount_usd_micros > 0
    AND price_max_units > 0
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS goat_capability_runs_plugin_spend_idx
  ON goat.capability_runs (workspace_id, plugin_name, created_at)
  WHERE plugin_name IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS goat.plugin_spend_limits (
  workspace_id text NOT NULL REFERENCES goat.workspaces(id) ON DELETE CASCADE,
  plugin_name text NOT NULL,
  daily_limit_usd_micros bigint NOT NULL,
  updated_by_workos_id text REFERENCES goat.users(workos_user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goat_plugin_spend_limits_pk PRIMARY KEY (workspace_id, plugin_name),
  CONSTRAINT goat_plugin_spend_limits_limit_check CHECK (daily_limit_usd_micros > 0)
);
