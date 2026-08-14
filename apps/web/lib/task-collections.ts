import type {
  TaskReportedOutcome,
  TaskStage,
  TaskStatus,
} from "@opencompany/agent/task-runtime-types";

export type TaskRow = {
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
  status: TaskStatus;
  stage: TaskStage;
  result: string | null;
  error: string | null;
  reported_outcome: TaskReportedOutcome | null;
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
