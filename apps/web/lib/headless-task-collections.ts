"use client";

import {
  type LegacyTaskDto,
  type TaskActivityReadModel,
  TaskActivityReadModelSchema,
  type TaskReadModel,
  TaskReadModelSchema,
} from "@opencompany/protocol";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import { createCollection } from "@tanstack/react-db";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";
import type { TaskRow } from "./task-collections";

const tasksByScope = new Map<string, ReturnType<typeof createTasks>>();
const activitiesByTask = new Map<string, ReturnType<typeof createTaskActivities>>();

function createTasks(scopeKey: string) {
  return createCollection(
    electricCollectionOptions({
      id: `headless-tasks:v1:${encodeURIComponent(scopeKey)}`,
      schema: TaskReadModelSchema,
      shapeOptions: {
        url: `${headlessChatApiBaseUrl()}/v1/read-models/tasks-v1`,
        fetchClient: createHeadlessChatApiFetch(),
      },
      getKey: (row) => row.id,
    }),
  );
}

export function getHeadlessTasks(scopeKey: string) {
  const cached = tasksByScope.get(scopeKey);
  if (cached) return cached;
  const collection = createTasks(scopeKey);
  tasksByScope.set(scopeKey, collection);
  return collection;
}

function createTaskActivities(taskId: string) {
  return createCollection(
    electricCollectionOptions({
      id: `headless-task-activities:v1:${encodeURIComponent(taskId)}`,
      schema: TaskActivityReadModelSchema,
      shapeOptions: {
        url: `${headlessChatApiBaseUrl()}/v1/read-models/task-activities-v1?taskId=${encodeURIComponent(taskId)}`,
        fetchClient: createHeadlessChatApiFetch(),
      },
      getKey: (row) => row.id,
    }),
  );
}

export function getHeadlessTaskActivities(taskId: string) {
  const cached = activitiesByTask.get(taskId);
  if (cached) return cached;
  const collection = createTaskActivities(taskId);
  activitiesByTask.set(taskId, collection);
  return collection;
}

export async function awaitHeadlessTaskTransaction(
  transactionIdValue: string,
  options: { scopeKey: string; timeoutMs?: number },
) {
  const transactionId = electricTransactionId(transactionIdValue);
  await getHeadlessTasks(options.scopeKey).utils.awaitTxId(transactionId, options.timeoutMs);
}

export async function awaitHeadlessTaskCommentTransaction(
  taskId: string,
  transactionIdValue: string,
  options: { scopeKey: string; timeoutMs?: number },
) {
  const transactionId = electricTransactionId(transactionIdValue);
  await Promise.all([
    getHeadlessTasks(options.scopeKey).utils.awaitTxId(transactionId, options.timeoutMs),
    getHeadlessTaskActivities(taskId).utils.awaitTxId(transactionId, options.timeoutMs),
  ]);
}

function electricTransactionId(transactionIdValue: string) {
  const transactionId = Number(transactionIdValue);
  if (!Number.isSafeInteger(transactionId) || transactionId < 1) {
    throw new Error("The API returned an invalid Electric transaction identifier.");
  }
  return transactionId;
}

// The current Task UI still consumes its established presentation row. This adapter deliberately
// derives legacy-only stage detail from canonical lifecycle state instead of exposing harness data
// through the public read model.
export function taskReadModelToRow(task: TaskReadModel): TaskRow {
  return taskDtoToRow(task, task.conversationId);
}

export function legacyTaskDtoToRow(task: LegacyTaskDto): TaskRow {
  return taskDtoToRow(task, null);
}

function taskDtoToRow(task: LegacyTaskDto, conversationId: string | null): TaskRow {
  const status = task.status === "archived" ? "succeeded" : canonicalUiStatus(task.status);
  return {
    id: task.id,
    display_id: task.displayId,
    name: task.name,
    user_workos_id: "",
    workspace_id: null,
    prompt: task.goal,
    model: task.model,
    engine: task.engine,
    session_id: conversationId,
    schedule_id: task.scheduleId,
    scheduled_for: task.scheduledFor,
    workflow_id: task.workflowId,
    workflow_brain_ref: null,
    status,
    stage:
      status === "queued"
        ? "queued"
        : status === "running"
          ? "running"
          : status === "succeeded" || status === "waiting"
            ? "completed"
            : status,
    result: task.outcome.result,
    error: task.outcome.error,
    reported_outcome: task.outcome.reportedStatus,
    outcome_comment: task.outcome.comment,
    harness_spec: {},
    debug_trace: {},
    sandbox_id: null,
    attempts: 0,
    next_run_at: task.updatedAt,
    lease_id: null,
    lease_owner: null,
    lease_expires_at: null,
    archived_at: task.archivedAt,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

function canonicalUiStatus(status: TaskReadModel["status"]) {
  return status === "blocked" ? "running" : status;
}

export type HeadlessTaskReadModel = TaskReadModel;
export type HeadlessTaskActivityReadModel = TaskActivityReadModel;
