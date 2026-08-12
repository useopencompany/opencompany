"use client";

import {
  type TaskScheduleReadModel,
  TaskScheduleReadModelSchema,
  type WorkflowReadModel,
  WorkflowReadModelSchema,
  type WorkflowScheduleReadModel,
  WorkflowScheduleReadModelSchema,
} from "@opencompany/protocol";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import { createCollection } from "@tanstack/react-db";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";

const workflowsByScope = new Map<string, ReturnType<typeof createWorkflows>>();
const workflowSchedulesByScope = new Map<string, ReturnType<typeof createWorkflowSchedules>>();
const taskSchedulesByScope = new Map<string, ReturnType<typeof createTaskSchedules>>();

function shapeOptions(readModel: string) {
  return {
    url: `${headlessChatApiBaseUrl()}/v1/read-models/${readModel}`,
    fetchClient: createHeadlessChatApiFetch(),
  };
}

function createWorkflows(scopeKey: string) {
  return createCollection(
    electricCollectionOptions({
      id: `headless-workflows:v1:${encodeURIComponent(scopeKey)}`,
      schema: WorkflowReadModelSchema,
      shapeOptions: shapeOptions("workflows-v1"),
      getKey: (row) => row.id,
    }),
  );
}

function createWorkflowSchedules(scopeKey: string) {
  return createCollection(
    electricCollectionOptions({
      id: `headless-workflow-schedules:v1:${encodeURIComponent(scopeKey)}`,
      schema: WorkflowScheduleReadModelSchema,
      shapeOptions: shapeOptions("workflow-schedules-v1"),
      getKey: (row) => row.id,
    }),
  );
}

function createTaskSchedules(scopeKey: string) {
  return createCollection(
    electricCollectionOptions({
      id: `headless-task-schedules:v1:${encodeURIComponent(scopeKey)}`,
      schema: TaskScheduleReadModelSchema,
      shapeOptions: shapeOptions("task-schedules-v1"),
      getKey: (row) => row.id,
    }),
  );
}

export function getHeadlessWorkflows(scopeKey = "active") {
  const cached = workflowsByScope.get(scopeKey);
  if (cached) return cached;
  const collection = createWorkflows(scopeKey);
  workflowsByScope.set(scopeKey, collection);
  return collection;
}

export function getHeadlessWorkflowSchedules(scopeKey = "active") {
  const cached = workflowSchedulesByScope.get(scopeKey);
  if (cached) return cached;
  const collection = createWorkflowSchedules(scopeKey);
  workflowSchedulesByScope.set(scopeKey, collection);
  return collection;
}

export function getHeadlessTaskSchedules(scopeKey = "active") {
  const cached = taskSchedulesByScope.get(scopeKey);
  if (cached) return cached;
  const collection = createTaskSchedules(scopeKey);
  taskSchedulesByScope.set(scopeKey, collection);
  return collection;
}

export async function awaitHeadlessWorkflowTransaction(
  transactionIdValue: string,
  options: { scopeKey?: string; timeoutMs?: number; includeSchedule?: boolean } = {},
) {
  const transactionId = transactionIdFromApi(transactionIdValue);
  const waits = [
    getHeadlessWorkflows(options.scopeKey).utils.awaitTxId(transactionId, options.timeoutMs),
  ];
  if (options.includeSchedule) {
    waits.push(
      getHeadlessWorkflowSchedules(options.scopeKey).utils.awaitTxId(
        transactionId,
        options.timeoutMs,
      ),
    );
  }
  await Promise.all(waits);
}

export async function awaitHeadlessTaskScheduleTransaction(
  transactionIdValue: string,
  options: { scopeKey?: string; timeoutMs?: number } = {},
) {
  await getHeadlessTaskSchedules(options.scopeKey).utils.awaitTxId(
    transactionIdFromApi(transactionIdValue),
    options.timeoutMs,
  );
}

function transactionIdFromApi(value: string) {
  const transactionId = Number(value);
  if (!Number.isSafeInteger(transactionId) || transactionId < 1) {
    throw new Error("The API returned an invalid Electric transaction identifier.");
  }
  return transactionId;
}

export type HeadlessWorkflowReadModel = WorkflowReadModel;
export type HeadlessWorkflowScheduleReadModel = WorkflowScheduleReadModel;
export type HeadlessTaskScheduleReadModel = TaskScheduleReadModel;
