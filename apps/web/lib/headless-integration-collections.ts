"use client";

import {
  type IntegrationAccountReadModel,
  IntegrationAccountReadModelSchema,
} from "@opencompany/protocol";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import { createCollection } from "@tanstack/react-db";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";

const integrationAccountsByScope = new Map<string, ReturnType<typeof createIntegrationAccounts>>();

function createIntegrationAccounts(scopeKey: string) {
  return createCollection(
    electricCollectionOptions({
      id: `headless-integration-accounts:v1:${encodeURIComponent(scopeKey)}`,
      schema: IntegrationAccountReadModelSchema,
      shapeOptions: {
        url: `${headlessChatApiBaseUrl()}/v1/read-models/integration-accounts-v1`,
        fetchClient: createHeadlessChatApiFetch(),
      },
      getKey: (row) => row.id,
    }),
  );
}

export function getHeadlessIntegrationAccounts(scopeKey = "active") {
  const cached = integrationAccountsByScope.get(scopeKey);
  if (cached) return cached;
  const collection = createIntegrationAccounts(scopeKey);
  integrationAccountsByScope.set(scopeKey, collection);
  return collection;
}

export type HeadlessIntegrationAccountReadModel = IntegrationAccountReadModel;
