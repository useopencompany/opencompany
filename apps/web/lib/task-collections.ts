import type {
  GoatTaskReportedOutcome,
  GoatTaskStage,
  GoatTaskStatus,
} from "@opencompany/goat-agent/task-runtime-types";
import { createGoatElectricCollection } from "@/lib/electric-collection";

type GoatIntegrationProvider =
  | "gmail"
  | "google_calendar"
  | "google_drive"
  | "linear"
  | "github"
  | "jamie"
  | "slack"
  | "slack_bot"
  | "hubspot"
  | "granola"
  | "fathom"
  | "attio"
  | "stripe"
  | "latitude"
  | "posthog"
  | "neon"
  | "imessage"
  | "x_account";
type GoatIntegrationStatus = "connected" | "needs_reauth" | "sync_failed" | "disconnected";

export type GoatTaskRow = {
  id: string;
  display_id: string;
  name: string;
  user_workos_id: string;
  workspace_id: string | null;
  prompt: string;
  model: string;
  engine?: "opencompany" | "codex" | "claude_code";
  session_id: string | null;
  schedule_id: string | null;
  scheduled_for: string | null;
  workflow_id: string | null;
  workflow_brain_ref: string | null;
  status: GoatTaskStatus;
  stage: GoatTaskStage;
  result: string | null;
  error: string | null;
  reported_outcome: GoatTaskReportedOutcome | null;
  outcome_comment: string | null;
  harness_spec: unknown;
  debug_trace: unknown;
  sandbox_id: string | null;
  attempts: number;
  next_run_at: string;
  lease_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GoatIntegrationRow = {
  id: string;
  user_workos_id: string;
  workspace_id: string | null;
  shared_with_workspace: boolean;
  provider: GoatIntegrationProvider;
  external_id: string;
  connection_label: string | null;
  account_name: string | null;
  account_email: string | null;
  account_type: string | null;
  status: GoatIntegrationStatus;
  status_reason: string | null;
  scopes: string[];
  capability_modes: Record<string, unknown>;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

function buildGoatCollections() {
  const integrations = createGoatElectricCollection<GoatIntegrationRow>({
    id: "goat:integrations",
    table: "goat.integrations",
    getKey: (row) => row.id,
  });

  return {
    integrations,
  };
}

let cachedGoatCollections: ReturnType<typeof buildGoatCollections> | null = null;

export function createGoatCollections() {
  cachedGoatCollections ??= buildGoatCollections();
  return cachedGoatCollections;
}

export type GoatCollections = ReturnType<typeof createGoatCollections>;
