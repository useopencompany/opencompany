"use client";

import type {
  AddWikiTimelineEntryBody,
  CreateWikiPageBody,
  DeleteWikiPageBody,
  UpdateWikiPageBody,
} from "@opencompany/protocol";
import {
  type CreateBrainDocumentBody,
  type CreateBrainFolderBody,
  type CreateSkillBody,
  createOpenCompanyClient,
  type DeleteBrainFolderBody,
  type RenameBrainDocumentBody,
  type RenameBrainFolderBody,
  type UpdateBrainDocumentBody,
  type UpdateSkillBody,
} from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";
import { awaitHeadlessWikiTransactions } from "./headless-knowledge-collections";
import {
  addWikiTimelineEntryRequest,
  createWikiPageRequest,
  deleteWikiPageRequest,
  updateWikiPageRequest,
} from "./headless-knowledge-wiki-api";

type ClientOptions = {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  scopeKey?: string;
};

export async function createHeadlessBrainDocument(
  brainId: string,
  command: CreateBrainDocumentBody,
  options: ClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.brains[":brainId"].documents.$post({
    param: { brainId },
    header: { "idempotency-key": `web-brain-document:${crypto.randomUUID()}` },
    json: command,
  });
  return responseData(response, "Brain document creation failed");
}

export async function updateHeadlessBrainDocument(
  brainId: string,
  documentId: string,
  command: UpdateBrainDocumentBody,
  options: ClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.brains[":brainId"].documents[
    ":documentId"
  ].$patch({ param: { brainId, documentId }, json: command });
  return responseData(response, "Brain document update failed");
}

export async function renameHeadlessBrainDocument(
  brainId: string,
  documentId: string,
  command: RenameBrainDocumentBody,
  options: ClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.brains[":brainId"].documents[
    ":documentId"
  ].rename.$post({ param: { brainId, documentId }, json: command });
  return responseData(response, "Brain document rename failed");
}

export async function deleteHeadlessBrainDocument(
  brainId: string,
  documentId: string,
  options: ClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.brains[":brainId"].documents[
    ":documentId"
  ].delete.$post({ param: { brainId, documentId } });
  return responseData(response, "Brain document deletion failed");
}

export async function createHeadlessBrainFolder(
  brainId: string,
  command: CreateBrainFolderBody,
  options: ClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.brains[":brainId"].folders.$post({
    param: { brainId },
    json: command,
  });
  return responseData(response, "Brain folder creation failed");
}

export async function renameHeadlessBrainFolder(
  brainId: string,
  command: RenameBrainFolderBody,
  options: ClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.brains[":brainId"].folders.rename.$post({
    param: { brainId },
    json: command,
  });
  return responseData(response, "Brain folder rename failed");
}

export async function deleteHeadlessBrainFolder(
  brainId: string,
  command: DeleteBrainFolderBody,
  options: ClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.brains[":brainId"].folders.delete.$post({
    param: { brainId },
    json: command,
  });
  return responseData(response, "Brain folder deletion failed");
}

export async function createHeadlessWikiPage(
  command: CreateWikiPageBody,
  options: ClientOptions = {},
) {
  const data = await createWikiPageRequest(command, options);
  await awaitHeadlessWikiTransactions(data.transactionIds, collectionOptions(options));
  return data.page;
}

export async function updateHeadlessWikiPage(
  slug: string,
  command: UpdateWikiPageBody,
  options: ClientOptions = {},
) {
  const data = await updateWikiPageRequest(slug, command, options);
  await awaitHeadlessWikiTransactions(data.transactionIds, collectionOptions(options));
  return data.page;
}

export async function deleteHeadlessWikiPage(
  slug: string,
  command: DeleteWikiPageBody,
  options: ClientOptions = {},
) {
  const data = await deleteWikiPageRequest(slug, command, options);
  await awaitHeadlessWikiTransactions(data.transactionIds, collectionOptions(options));
  return data;
}

export async function addHeadlessWikiTimelineEntry(
  slug: string,
  command: AddWikiTimelineEntryBody,
  options: ClientOptions = {},
) {
  const data = await addWikiTimelineEntryRequest(slug, command, options);
  await awaitHeadlessWikiTransactions([data.transactionId], {
    ...collectionOptions(options),
    target: "timeline",
  });
  return data.entry;
}

export async function createHeadlessSkill(command: CreateSkillBody, options: ClientOptions = {}) {
  const response = await knowledgeClient(options).v1.skills.$post({
    header: { "idempotency-key": `web-skill:${crypto.randomUUID()}` },
    json: command,
  });
  return responseData(response, "Skill creation failed");
}

export async function updateHeadlessSkill(
  slug: string,
  command: UpdateSkillBody,
  options: ClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.skills[":slug"].$patch({
    param: { slug },
    json: command,
  });
  return responseData(response, "Skill update failed");
}

export async function archiveHeadlessSkill(slug: string, options: ClientOptions = {}) {
  const response = await knowledgeClient(options).v1.skills[":slug"].archive.$post({
    param: { slug },
  });
  return responseData(response, "Skill archive failed");
}

export async function listHeadlessSkillCatalog(options: ClientOptions = {}) {
  const response = await knowledgeClient(options).v1.skills.catalog.$get();
  return responseData(response, "Skill catalog loading failed");
}

function knowledgeClient(options: ClientOptions) {
  const baseUrl = options.baseUrl ?? headlessChatApiBaseUrl();
  return createOpenCompanyClient(baseUrl, {
    fetch: createHeadlessChatApiFetch({
      baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
}

function collectionOptions(options: ClientOptions) {
  return options.scopeKey ? { scopeKey: options.scopeKey } : {};
}

async function responseData<T>(
  response: Response & { json(): Promise<{ data: T }> },
  fallback: string,
) {
  if (!response.ok) throw await knowledgeResponseError(response, fallback);
  return (await response.json()).data;
}

async function knowledgeResponseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : null;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(
    `${message ?? `${fallback} with HTTP ${response.status}.`}${requestId ? ` (request ${requestId})` : ""}`,
  );
}
