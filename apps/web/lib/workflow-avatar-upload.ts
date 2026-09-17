"use client";

import { createApiClient } from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";

// Returns the public URL for the stored image. The caller saves it onto the workflow through the
// normal update command, so an upload that is never saved leaves the workflow untouched.
export async function uploadWorkflowSlackAvatar(
  input: { workflowId: string; file: File },
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
) {
  const baseUrl = options.baseUrl ?? headlessChatApiBaseUrl();
  const client = createApiClient(baseUrl, {
    fetch: createHeadlessChatApiFetch({
      baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
  const response = await client.v1.workflows[":workflowId"]["slack-avatar"].$post({
    param: { workflowId: input.workflowId },
    form: { file: input.file },
  });
  if (!response.ok) throw await avatarUploadError(response);
  return (await response.json()).data.avatarUrl;
}

async function avatarUploadError(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : null;
  return new Error(message ?? `The avatar upload failed with HTTP ${response.status}.`);
}
