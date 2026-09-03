import {
  type Actor,
  actorHasPermission,
  TASK_READ_PERMISSION,
  TASK_WRITE_PERMISSION,
} from "./actor";
import { CHAT_ATTACHMENTS_PER_MESSAGE } from "./attachments";
import { CHAT_ENGINES, type ChatEngine, CoreError } from "./chat";

export const TASK_STATUSES = [
  "queued",
  "running",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "canceled",
  "archived",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_SOURCES = ["manual", "workflow", "schedule", "agent"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export type TaskOutcome = {
  result: string | null;
  error: string | null;
  reportedStatus: "done" | "needs_attention" | null;
  comment: string | null;
};

export type Task = {
  id: string;
  displayId: string;
  name: string;
  goal: string;
  conversationId: string;
  status: TaskStatus;
  source: TaskSource;
  engine: ChatEngine;
  model: string;
  workflowId: string | null;
  scheduleId: string | null;
  scheduledFor: Date | null;
  outcome: TaskOutcome;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskPage = {
  tasks: Task[];
  nextCursor: string | null;
};

export type TaskSummary = {
  cost: {
    hasRecordedCosts: boolean;
    totalCostUsdMicros: number;
  };
  durationMs: number | null;
};

export type LegacyTask = Omit<Task, "conversationId">;

export type LegacyTaskHistoryMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  status: "created" | "running" | "completed" | "failed";
  content: string;
  toolName: string | null;
  toolCallId: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

export type LegacyTaskHistoryEvent = {
  id: number;
  messageId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

export type LegacyTaskHistory = {
  task: LegacyTask;
  messages: LegacyTaskHistoryMessage[];
  events: LegacyTaskHistoryEvent[];
};

export type CreateTaskCommand = {
  idempotencyKey: string;
  name?: string;
  goal: string;
  engine: ChatEngine;
  model: string;
  attachmentIds?: readonly string[];
  source: TaskSource;
  workflowId?: string;
  scheduleId?: string;
  scheduledFor?: Date;
};

export type CreateTaskResult = {
  task: Task;
  messageId: string;
  assistantMessageId: string;
  runId: string;
  transactionId: string;
  idempotentReplay: boolean;
};

export type CreateTaskCommentCommand = {
  id: string;
  body: string;
};

export type TaskComment = {
  id: string;
  taskId: string;
  authorWorkosId: string;
  body: string;
  createdAt: Date;
};

export type CreateTaskCommentResult = {
  task: Task;
  comment: TaskComment;
  messageId: string;
  assistantMessageId: string;
  runId: string;
  transactionId: string;
  idempotentReplay: boolean;
};

export type UpdateTaskCommand = { archived: boolean } | { name: string };

export type UpdateTaskResult = {
  task: Task;
  transactionId: string;
};

export interface TaskRepository {
  listTasks(input: {
    actor: Actor;
    cursor?: string;
    limit: number;
    archived: boolean;
  }): Promise<TaskPage>;
  getTask(input: { actor: Actor; taskId: string }): Promise<Task | null>;
  getTaskSummary(input: { actor: Actor; taskId: string }): Promise<TaskSummary | null>;
  listLegacyTasks(input: { actor: Actor; limit: number }): Promise<LegacyTask[]>;
  getLegacyTaskHistory(input: { actor: Actor; taskId: string }): Promise<LegacyTaskHistory | null>;
  getTaskByConversation(input: { actor: Actor; conversationId: string }): Promise<Task | null>;
  createTaskAndRun(input: { actor: Actor; command: CreateTaskCommand }): Promise<CreateTaskResult>;
  createTaskCommentAndRun(input: {
    actor: Actor;
    taskId: string;
    command: CreateTaskCommentCommand;
  }): Promise<CreateTaskCommentResult | null>;
  updateTask(input: {
    actor: Actor;
    taskId: string;
    command: UpdateTaskCommand;
  }): Promise<UpdateTaskResult | null>;
}

const MAX_GOAL_LENGTH = 10_000;
const MAX_COMMENT_LENGTH = 10_000;
const MAX_NAME_LENGTH = 160;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_RESOURCE_ID_LENGTH = 256;
const MAX_MODEL_ID_LENGTH = 256;

export class TaskApplicationService {
  constructor(private readonly repository: TaskRepository) {}

  listTasks(
    actor: Actor,
    input: { cursor?: string; limit?: number; archived?: boolean } = {},
  ): Promise<TaskPage> {
    requireTaskPermission(actor, TASK_READ_PERMISSION);
    return this.repository.listTasks({
      actor,
      ...(input.cursor ? { cursor: boundedValue(input.cursor, "cursor") } : {}),
      limit: Math.max(1, Math.min(input.limit ?? 25, 100)),
      archived: input.archived ?? false,
    });
  }

  async getTask(actor: Actor, taskId: string): Promise<Task> {
    requireTaskPermission(actor, TASK_READ_PERMISSION);
    const task = await this.repository.getTask({
      actor,
      taskId: resourceId(taskId, "taskId"),
    });
    if (!task) throw new CoreError("not_found", "Task not found.");
    return task;
  }

  async getTaskSummary(actor: Actor, taskId: string): Promise<TaskSummary> {
    requireTaskPermission(actor, TASK_READ_PERMISSION);
    const summary = await this.repository.getTaskSummary({
      actor,
      taskId: resourceId(taskId, "taskId"),
    });
    if (!summary) throw new CoreError("not_found", "Task not found.");
    return summary;
  }

  listLegacyTasks(actor: Actor, input: { limit?: number } = {}): Promise<LegacyTask[]> {
    requireTaskPermission(actor, TASK_READ_PERMISSION);
    return this.repository.listLegacyTasks({
      actor,
      limit: Math.max(1, Math.min(input.limit ?? 100, 100)),
    });
  }

  async getLegacyTaskHistory(actor: Actor, taskId: string): Promise<LegacyTaskHistory> {
    requireTaskPermission(actor, TASK_READ_PERMISSION);
    const history = await this.repository.getLegacyTaskHistory({
      actor,
      taskId: resourceId(taskId, "taskId"),
    });
    if (!history) throw new CoreError("not_found", "Legacy Task history not found.");
    return history;
  }

  async getTaskByConversation(actor: Actor, conversationId: string): Promise<Task> {
    requireTaskPermission(actor, TASK_READ_PERMISSION);
    const task = await this.repository.getTaskByConversation({
      actor,
      conversationId: resourceId(conversationId, "conversationId"),
    });
    if (!task) throw new CoreError("not_found", "Task not found.");
    return task;
  }

  createTask(actor: Actor, input: CreateTaskCommand): Promise<CreateTaskResult> {
    requireTaskPermission(actor, TASK_WRITE_PERMISSION);
    const idempotencyKey = input.idempotencyKey.trim();
    if (
      !idempotencyKey ||
      idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
      /[^\x21-\x7e]/u.test(idempotencyKey)
    ) {
      throw new CoreError("invalid_argument", "A valid Idempotency-Key is required.");
    }
    const goal = input.goal.trim();
    if (!goal) throw new CoreError("invalid_argument", "A Task goal is required.");
    if (goal.length > MAX_GOAL_LENGTH) {
      throw new CoreError(
        "invalid_argument",
        `A Task goal cannot exceed ${MAX_GOAL_LENGTH} characters.`,
      );
    }
    if (!CHAT_ENGINES.includes(input.engine)) {
      throw new CoreError("invalid_argument", "Unknown Task engine.");
    }
    const model = input.model.trim();
    if (!model || model.length > MAX_MODEL_ID_LENGTH) {
      throw new CoreError("invalid_argument", "A valid model is required.");
    }
    if (!TASK_SOURCES.includes(input.source)) {
      throw new CoreError("invalid_argument", "Unknown Task source.");
    }
    const attachmentIds = (input.attachmentIds ?? []).map((id) => resourceId(id, "attachmentId"));
    if (attachmentIds.length > CHAT_ATTACHMENTS_PER_MESSAGE) {
      throw new CoreError(
        "invalid_argument",
        `A Task cannot contain more than ${CHAT_ATTACHMENTS_PER_MESSAGE} attachments.`,
      );
    }
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new CoreError("invalid_argument", "Attachment references must be unique.");
    }
    const name = taskNameFromGoal(input.name?.trim() || goal);
    if (name.length > MAX_NAME_LENGTH) {
      throw new CoreError(
        "invalid_argument",
        `A Task name cannot exceed ${MAX_NAME_LENGTH} characters.`,
      );
    }
    const scheduledFor = input.scheduledFor;
    if (scheduledFor && Number.isNaN(scheduledFor.getTime())) {
      throw new CoreError("invalid_argument", "scheduledFor is invalid.");
    }

    return this.repository.createTaskAndRun({
      actor,
      command: {
        idempotencyKey,
        name,
        goal,
        engine: input.engine,
        model,
        source: input.source,
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(input.workflowId ? { workflowId: resourceId(input.workflowId, "workflowId") } : {}),
        ...(input.scheduleId ? { scheduleId: resourceId(input.scheduleId, "scheduleId") } : {}),
        ...(scheduledFor ? { scheduledFor } : {}),
      },
    });
  }

  async createComment(
    actor: Actor,
    taskId: string,
    input: CreateTaskCommentCommand,
  ): Promise<CreateTaskCommentResult> {
    requireTaskPermission(actor, TASK_WRITE_PERMISSION);
    const body = input.body;
    if (!body.trim()) throw new CoreError("invalid_argument", "A comment is required.");
    if (body.length > MAX_COMMENT_LENGTH) {
      throw new CoreError(
        "invalid_argument",
        `A comment cannot exceed ${MAX_COMMENT_LENGTH} characters.`,
      );
    }
    const result = await this.repository.createTaskCommentAndRun({
      actor,
      taskId: resourceId(taskId, "taskId"),
      command: {
        id: resourceId(input.id, "commentId"),
        // Whitespace is deliberately preserved: this exact body becomes the next user Message.
        body,
      },
    });
    if (!result) throw new CoreError("not_found", "Task not found.");
    return result;
  }

  async updateTask(
    actor: Actor,
    taskId: string,
    command: UpdateTaskCommand,
  ): Promise<UpdateTaskResult> {
    requireTaskPermission(actor, TASK_WRITE_PERMISSION);
    let normalizedCommand: UpdateTaskCommand;
    if ("archived" in command) {
      if (typeof command.archived !== "boolean") {
        throw new CoreError("invalid_argument", "A Task archive update is required.");
      }
      normalizedCommand = { archived: command.archived };
    } else {
      normalizedCommand = { name: boundedTaskName(command.name) };
    }
    const result = await this.repository.updateTask({
      actor,
      taskId: resourceId(taskId, "taskId"),
      command: normalizedCommand,
    });
    if (!result) throw new CoreError("not_found", "Task not found.");
    return result;
  }
}

function requireTaskPermission(actor: Actor, permission: string) {
  if (!actor.userId.trim() || !actor.workspaceId.trim() || !actorHasPermission(actor, permission)) {
    throw new CoreError("forbidden", "The actor is not allowed to access Tasks.");
  }
}

function resourceId(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_RESOURCE_ID_LENGTH) {
    throw new CoreError("invalid_argument", `${field} is invalid.`);
  }
  return normalized;
}

function boundedValue(value: string, field: string) {
  return resourceId(value, field);
}

function boundedTaskName(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_NAME_LENGTH) {
    throw new CoreError("invalid_argument", "name is invalid.");
  }
  return normalized;
}

export function taskNameFromGoal(goal: string) {
  const firstLine =
    goal
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? "Untitled task";
  const cleaned = firstLine
    .replace(/^(please\s+)?(can|could|would)\s+you\s+/iu, "")
    .replace(/^(please\s+)?(help me|i need you to|i want you to)\s+/iu, "")
    .replace(/\s+/gu, " ")
    .replace(/[.!?]+$/u, "")
    .trim();
  const words = cleaned.split(/\s+/u).filter(Boolean).slice(0, 7).join(" ");
  const clipped = words.length > 48 ? `${words.slice(0, 48).trimEnd()}...` : words;
  const fallback = clipped || "Untitled task";
  return fallback.charAt(0).toUpperCase() + fallback.slice(1);
}
