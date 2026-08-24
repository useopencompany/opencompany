"use client";

import type {
  AddWikiTimelineEntryBody,
  CreateWikiPageBody,
  DeleteWikiPageBody,
  UpdateWikiPageBody,
} from "@opencompany/protocol";
import {
  type BrainSourceItemDto,
  type CreateBrainDocumentBody,
  type CreateBrainFolderBody,
  type CreateSkillBody,
  createApiClient,
  type DeleteBrainFolderBody,
  type ImportSkillBody,
  type InstallPluginBody,
  type PluginImportPreviewBody,
  type RenameBrainDocumentBody,
  type RenameBrainFolderBody,
  type SkillImportPreviewBody,
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
};
type ScopedClientOptions = ClientOptions & { scopeKey: string };

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

export async function listHeadlessBrainSourceItems(
  brainId: string,
  ids: string[],
  options: ClientOptions = {},
): Promise<BrainSourceItemDto[]> {
  if (ids.length === 0) return [];
  if (ids.length > 100) throw new Error("Brain source-item lookups are limited to 100 ids.");
  const response = await knowledgeClient(options).v1.brains[":brainId"]["source-items"].$get({
    param: { brainId },
    query: { ids: ids.join(",") },
  });
  return responseData(response, "Brain activity metadata loading failed");
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
  options: ScopedClientOptions,
) {
  const data = await createWikiPageRequest(command, options);
  await awaitHeadlessWikiTransactions(data.transactionIds, collectionOptions(options));
  return data.page;
}

export async function updateHeadlessWikiPage(
  id: string,
  command: UpdateWikiPageBody,
  options: ScopedClientOptions,
) {
  const data = await updateWikiPageRequest(id, command, options);
  await awaitHeadlessWikiTransactions(data.transactionIds, collectionOptions(options));
  return data.page;
}

export async function deleteHeadlessWikiPage(
  id: string,
  command: DeleteWikiPageBody,
  options: ScopedClientOptions,
) {
  const data = await deleteWikiPageRequest(id, command, options);
  await awaitHeadlessWikiTransactions(data.transactionIds, collectionOptions(options));
  return data;
}

export async function addHeadlessWikiTimelineEntry(
  id: string,
  command: AddWikiTimelineEntryBody,
  options: ScopedClientOptions,
) {
  const data = await addWikiTimelineEntryRequest(id, command, options);
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

export async function previewHeadlessSkillImport(
  command: SkillImportPreviewBody,
  options: ClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.skills.imports.preview.$post({
    json: command,
  });
  return responseData(response, "Skill import preview failed");
}

export async function importHeadlessSkill(command: ImportSkillBody, options: ClientOptions = {}) {
  const response = await knowledgeClient(options).v1.skills.imports.$post({
    header: { "idempotency-key": `web-skill-import:${crypto.randomUUID()}` },
    json: command,
  });
  return responseData(response, "Skill import failed");
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

export async function enableHeadlessSkill(slug: string, options: ClientOptions = {}) {
  const response = await knowledgeClient(options).v1.skills[":slug"].enable.$post({
    param: { slug },
  });
  return responseData(response, "Skill enable failed");
}

export async function disableHeadlessSkill(slug: string, options: ClientOptions = {}) {
  const response = await knowledgeClient(options).v1.skills[":slug"].disable.$post({
    param: { slug },
  });
  return responseData(response, "Skill disable failed");
}

export async function replaceHeadlessSkill(
  slug: string,
  command: ImportSkillBody,
  options: ClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.skills[":slug"].replace.$post({
    param: { slug },
    json: command,
  });
  return responseData(response, "Skill replacement failed");
}

export async function readHeadlessSkillFile(
  slug: string,
  query: { path: string; offset?: number; maxBytes?: number },
  options: ClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.skills[":slug"].files.read.$get({
    param: { slug },
    query: {
      path: query.path,
      ...(query.offset !== undefined ? { offset: String(query.offset) } : {}),
      ...(query.maxBytes !== undefined ? { maxBytes: String(query.maxBytes) } : {}),
    },
  });
  return responseData(response, "Skill file loading failed");
}

export async function listHeadlessSkillCatalog(options: ClientOptions = {}) {
  const response = await knowledgeClient(options).v1.skills.catalog.$get();
  return responseData(response, "Skill catalog loading failed");
}

export async function previewHeadlessPluginImport(
  command: PluginImportPreviewBody,
  options: ClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.plugins.imports.preview.$post({
    json: command,
  });
  return responseData(response, "Plugin import preview failed");
}

export async function importHeadlessPlugin(
  command: InstallPluginBody,
  options: ClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.plugins.imports.$post({
    header: { "idempotency-key": `web-plugin-import:${crypto.randomUUID()}` },
    json: command,
  });
  return responseData(response, "Plugin import failed");
}

export async function archiveHeadlessPlugin(name: string, options: ClientOptions = {}) {
  const response = await knowledgeClient(options).v1.plugins[":name"].archive.$post({
    param: { name },
  });
  return responseData(response, "Plugin archive failed");
}

export async function enableHeadlessPlugin(name: string, options: ClientOptions = {}) {
  const response = await knowledgeClient(options).v1.plugins[":name"].enable.$post({
    param: { name },
  });
  return responseData(response, "Plugin enable failed");
}

export async function disableHeadlessPlugin(name: string, options: ClientOptions = {}) {
  const response = await knowledgeClient(options).v1.plugins[":name"].disable.$post({
    param: { name },
  });
  return responseData(response, "Plugin disable failed");
}

export async function approveHeadlessPluginMcp(
  name: string,
  integrity: string,
  options: ClientOptions = {},
) {
  const response = await knowledgeClient(options).v1.plugins[":name"].mcp.approve.$post({
    param: { name },
    json: { integrity },
  });
  return responseData(response, "Plugin MCP approval failed");
}

export async function revokeHeadlessPluginMcp(name: string, options: ClientOptions = {}) {
  const response = await knowledgeClient(options).v1.plugins[":name"].mcp.revoke.$post({
    param: { name },
  });
  return responseData(response, "Plugin MCP revocation failed");
}

export async function deleteHeadlessPluginData(name: string, options: ClientOptions = {}) {
  const response = await knowledgeClient(options).v1.plugins[":name"].data.delete.$post({
    param: { name },
  });
  return responseData(response, "Plugin data deletion failed");
}

function knowledgeClient(options: ClientOptions) {
  const baseUrl = options.baseUrl ?? headlessChatApiBaseUrl();
  return createApiClient(baseUrl, {
    fetch: createHeadlessChatApiFetch({
      baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
}

function collectionOptions(options: ScopedClientOptions) {
  return { scopeKey: options.scopeKey };
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
