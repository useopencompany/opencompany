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
