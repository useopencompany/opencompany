import type {
  GoatBrainFolderSource,
  GoatIntegrationProvider,
  GoatIntegrationStatus,
  GoatTaskEventType,
  GoatTaskMessageRole,
  GoatTaskMessageStatus,
  GoatTaskStage,
  GoatTaskStatus,
  GoatTaskToolName,
} from "@opencompany/db/goat-schema";
import { createGoatElectricCollection } from "@/lib/electric-collection";

type ElectricNumber = number | string;

export type GoatTaskRow = {
  id: string;
  display_id: string;
  name: string;
  user_workos_id: string;
  prompt: string;
  model: string;
  status: GoatTaskStatus;
  stage: GoatTaskStage;
  result: string | null;
  error: string | null;
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

export type GoatTaskMessageRow = {
  id: string;
  task_id: string;
  user_workos_id: string;
  role: GoatTaskMessageRole;
  status: GoatTaskMessageStatus;
  content: string;
  model_message: unknown | null;
  tool_name: GoatTaskToolName | null;
  tool_call_id: string | null;
  response_to_message_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type GoatTaskEventRow = {
  id: number;
  task_id: string;
  user_workos_id: string;
  message_id: string | null;
  type: GoatTaskEventType;
  payload: Record<string, unknown>;
  created_at: string;
};

export type GoatTaskModelUsageRow = {
  id: number;
  task_id: string;
  user_workos_id: string;
  message_id: string | null;
  run_lease_id: string | null;
  phase: string;
  step_index: number;
  model_provider: string;
  model_name: string;
  response_id: string | null;
  response_model_id: string | null;
  finish_reason: string | null;
  raw_finish_reason: string | null;
  input_tokens: ElectricNumber;
  input_no_cache_tokens: ElectricNumber;
  input_cache_read_tokens: ElectricNumber;
  input_cache_write_tokens: ElectricNumber;
  output_tokens: ElectricNumber;
  output_text_tokens: ElectricNumber;
  output_reasoning_tokens: ElectricNumber;
  total_tokens: ElectricNumber;
  raw_usage: Record<string, unknown>;
  provider_created_at: string | null;
  provider_cost_usd_micros: ElectricNumber;
  platform_fee_usd_micros: ElectricNumber;
  total_cost_usd_micros: ElectricNumber;
  cost_basis: Record<string, unknown>;
  created_at: string;
};

export type GoatTaskToolUsageRow = {
  id: number;
  task_id: string;
  user_workos_id: string;
  message_id: string | null;
  run_lease_id: string | null;
  tool_call_id: string;
  tool_name: string;
  provider: string;
  operation: string;
  provider_request_id: string | null;
  provider_cost_usd_micros: ElectricNumber;
  platform_fee_usd_micros: ElectricNumber;
  total_cost_usd_micros: ElectricNumber;
  raw_usage: Record<string, unknown>;
  cost_basis: Record<string, unknown>;
  created_at: string;
};

export type GoatTaskSandboxUsageRow = {
  id: number;
  task_id: string;
  user_workos_id: string;
  message_id: string | null;
  run_lease_id: string | null;
  sandbox_id: string;
  template: string | null;
  vcpu: number | null;
  ram_mib: number | null;
  started_at: string | null;
  ended_at: string | null;
  active_ms: ElectricNumber;
  provider_cost_usd_micros: ElectricNumber;
  platform_fee_usd_micros: ElectricNumber;
  total_cost_usd_micros: ElectricNumber;
  raw_metrics: Record<string, unknown>;
  cost_basis: Record<string, unknown>;
  created_at: string;
};

export type GoatIntegrationRow = {
  id: string;
  user_workos_id: string;
  provider: GoatIntegrationProvider;
  external_id: string;
  connection_label: string | null;
  account_name: string | null;
  account_email: string | null;
  account_type: string | null;
  status: GoatIntegrationStatus;
  status_reason: string | null;
  scopes: string[];
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GoatBrainFolderRow = {
  id: string;
  user_workos_id: string;
  path: string;
  source: GoatBrainFolderSource;
  created_at: string;
  updated_at: string;
};

export type GoatBrainDocumentRow = {
  id: string;
  user_workos_id: string;
  brain_id: string;
  folder_path: string;
  title: string | null;
  content: string;
  body: string;
  timeline: unknown[];
  kind: string;
  mime_type: string | null;
  original_file_name: string | null;
  asset_storage_key: string | null;
  related: unknown[];
  sources: unknown[];
  content_hash: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
};

export function createGoatCollections() {
  const tasks = createGoatElectricCollection<GoatTaskRow>({
    id: "goat:tasks",
    table: "goat.tasks",
    getKey: (row) => row.id,
  });

  const taskRunCollections = (taskId: string) => ({
    messages: createGoatElectricCollection<GoatTaskMessageRow>({
      id: `goat:task_messages:${taskId}`,
      table: "goat.task_messages",
      params: { task_id: taskId },
      getKey: (row) => row.id,
    }),
    events: createGoatElectricCollection<GoatTaskEventRow>({
      id: `goat:task_events:${taskId}`,
      table: "goat.task_events",
      params: { task_id: taskId },
      getKey: (row) => row.id,
    }),
    modelUsage: createGoatElectricCollection<GoatTaskModelUsageRow>({
      id: `goat:task_model_usage:${taskId}`,
      table: "goat.task_model_usage",
      params: { task_id: taskId },
      getKey: (row) => row.id,
    }),
    toolUsage: createGoatElectricCollection<GoatTaskToolUsageRow>({
      id: `goat:task_tool_usage:${taskId}`,
      table: "goat.task_tool_usage",
      params: { task_id: taskId },
      getKey: (row) => row.id,
    }),
    sandboxUsage: createGoatElectricCollection<GoatTaskSandboxUsageRow>({
      id: `goat:task_sandbox_usage:${taskId}`,
      table: "goat.task_sandbox_usage",
      params: { task_id: taskId },
      getKey: (row) => row.id,
    }),
  });

  const integrations = createGoatElectricCollection<GoatIntegrationRow>({
    id: "goat:integrations",
    table: "goat.integrations",
    getKey: (row) => row.id,
  });

  const brainFolders = createGoatElectricCollection<GoatBrainFolderRow>({
    id: "goat:brain_folders",
    table: "goat.brain_folders",
    getKey: (row) => row.id,
  });

  const brainDocuments = createGoatElectricCollection<GoatBrainDocumentRow>({
    id: "goat:brain_documents",
    table: "goat.brain_documents",
    getKey: (row) => row.id,
  });

  return { tasks, taskRunCollections, integrations, brainFolders, brainDocuments };
}

export const createGoatTaskCollections = createGoatCollections;

export type GoatCollections = ReturnType<typeof createGoatCollections>;
export type GoatTaskCollections = GoatCollections;
