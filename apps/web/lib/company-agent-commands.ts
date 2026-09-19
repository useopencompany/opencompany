"use client";

import {
  type ArchiveVersionBody,
  type CreateCompanyAgentBody,
  createApiClient,
  type UpdateCompanyAgentBody,
} from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";

type ClientOptions = {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

export async function createCompanyAgent(
  command: CreateCompanyAgentBody,
  options: ClientOptions = {},
) {
  const response = await agentClient(options).v1.agents.$post({
    header: { "idempotency-key": `web-agent:${crypto.randomUUID()}` },
    json: command,
  });
  if (!response.ok) throw await agentResponseError(response, "Agent creation failed");
  return (await response.json()).data.agent;
}

export async function updateCompanyAgent(
  agentId: string,
  command: UpdateCompanyAgentBody,
  options: ClientOptions = {},
) {
  const response = await agentClient(options).v1.agents[":agentId"].$patch({
    param: { agentId },
    json: command,
  });
  if (!response.ok) throw await agentResponseError(response, "Agent update failed");
  return (await response.json()).data.agent;
}

export async function archiveCompanyAgent(
  agentId: string,
  command: ArchiveVersionBody,
  options: ClientOptions = {},
) {
  const response = await agentClient(options).v1.agents[":agentId"].archive.$post({
    param: { agentId },
    json: command,
  });
  if (!response.ok) throw await agentResponseError(response, "Agent archive failed");
  return (await response.json()).data;
}

// The run executes with the agent owner's authority regardless of who calls this.
export async function runCompanyAgentNow(agentId: string, options: ClientOptions = {}) {
  const response = await agentClient(options).v1.agents[":agentId"].run.$post({
    param: { agentId },
    header: { "idempotency-key": `web-agent-run:${crypto.randomUUID()}` },
  });
  if (!response.ok) throw await agentResponseError(response, "Agent run failed");
  return (await response.json()).data;
}

// Returns the public URL for the stored image. The caller saves it onto the agent through the
// normal update command, so an upload that is never saved leaves the agent untouched.
export async function uploadCompanyAgentPhoto(
  input: { agentId: string; file: File },
  options: ClientOptions = {},
) {
  const response = await agentClient(options).v1.agents[":agentId"].photo.$post({
    param: { agentId: input.agentId },
    form: { file: input.file },
  });
  if (!response.ok) throw await agentResponseError(response, "The photo upload failed");
  return (await response.json()).data.photoUrl;
}

function agentClient(options: ClientOptions) {
  const baseUrl = options.baseUrl ?? headlessChatApiBaseUrl();
  return createApiClient(baseUrl, {
    fetch: createHeadlessChatApiFetch({
      baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
}

async function agentResponseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : null;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(
    `${message ?? `${fallback} with HTTP ${response.status}.`}${requestId ? ` (request ${requestId})` : ""}`,
  );
}

export async function getCompanyAgentSlack(agentId: string) {
  const response = await agentClient({}).v1.agents[":agentId"].slack.$get({ param: { agentId } });
  if (!response.ok) throw await agentResponseError(response, "Slack setup could not be loaded");
  return (await response.json()).data;
}

export async function connectCompanyAgentSlack(
  agentId: string,
  credentials?: { botToken: string; signingSecret: string },
) {
  const response = await agentClient({}).v1.agents[":agentId"].slack.$post({
    param: { agentId },
    json: credentials ?? {},
  });
  if (!response.ok) throw await agentResponseError(response, "Slack connection failed");
  return (await response.json()).data;
}

export async function disconnectCompanyAgentSlack(agentId: string) {
  const response = await agentClient({}).v1.agents[":agentId"].slack.$delete({
    param: { agentId },
  });
  if (!response.ok) throw await agentResponseError(response, "Slack disconnect failed");
}

export async function getSlackProvisioning() {
  const response = await agentClient({}).v1.workspace["slack-provisioning"].$get();
  if (!response.ok) throw await agentResponseError(response, "Slack setup could not be loaded");
  return (await response.json()).data;
}
export async function startSlackProvisioning() {
  const response = await agentClient({}).v1.workspace["slack-provisioning"].start.$post();
  if (!response.ok) throw await agentResponseError(response, "Slack setup could not start");
  return (await response.json()).data;
}
export async function completeSlackProvisioning(attemptId: string, challenge: string) {
  const response = await agentClient({}).v1.workspace["slack-provisioning"].complete.$post({
    json: { attemptId, challenge },
  });
  if (!response.ok) throw await agentResponseError(response, "Slack authorization failed");
  return (await response.json()).data;
}
export async function disconnectSlackProvisioning() {
  const response = await agentClient({}).v1.workspace["slack-provisioning"].$delete();
  if (!response.ok)
    throw await agentResponseError(response, "Slack authorization could not be removed");
  return (await response.json()).data;
}

export async function confirmSlackProvisioning(attemptId: string) {
  const response = await agentClient({}).v1.workspace["slack-provisioning"].confirm.$post({
    json: { attemptId },
  });
  if (!response.ok)
    throw await agentResponseError(response, "Slack workspace could not be connected");
  return (await response.json()).data;
}
