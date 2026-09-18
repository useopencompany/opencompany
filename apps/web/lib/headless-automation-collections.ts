"use client";

import { type WorkflowReadModel, WorkflowReadModelSchema } from "@opencompany/protocol";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import { createCollection } from "@tanstack/react-db";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";

const workflowsByScope = new Map<string, ReturnType<typeof createWorkflows>>();

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

export function getHeadlessWorkflows(scopeKey: string) {
  const cached = workflowsByScope.get(scopeKey);
  if (cached) return cached;
  const collection = createWorkflows(scopeKey);
  workflowsByScope.set(scopeKey, collection);
  return collection;
}

export type HeadlessWorkflowReadModel = WorkflowReadModel;
