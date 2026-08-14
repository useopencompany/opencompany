"use client";

import { type BrowserProfileDto, createOpenCompanyClient } from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";

type ClientOptions = {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

export type HeadlessBrowserProfile = BrowserProfileDto;

export async function listHeadlessBrowserProfiles(
  options: ClientOptions = {},
): Promise<HeadlessBrowserProfile[]> {
  const response = await profileClient(options).v1["browser-profiles"].$get();
  return responseData(response, "Could not load browser profiles");
}

export async function createHeadlessBrowserProfile(
  input: { name: string; url: string },
  options: ClientOptions = {},
): Promise<HeadlessBrowserProfile> {
  const response = await profileClient(options).v1["browser-profiles"].$post({ json: input });
  return responseData(response, "Could not create browser profile");
}

export async function deleteHeadlessBrowserProfile(
  profileId: string,
  options: ClientOptions = {},
): Promise<void> {
  const response = await profileClient(options).v1["browser-profiles"][":profileId"].$delete({
    param: { profileId },
  });
  await responseData(response, "Could not delete browser profile");
}

export async function createHeadlessBrowserProfileLoginSession(
  profileId: string,
  options: ClientOptions = {},
): Promise<{ profileId: string; sessionId: string; liveViewUrl: string }> {
  const response = await profileClient(options).v1["browser-profiles"][":profileId"][
    "login-sessions"
  ].$post({ param: { profileId } });
  return responseData(response, "Could not start login session");
}

export async function completeHeadlessBrowserProfileLogin(
  profileId: string,
  sessionId: string,
  options: ClientOptions = {},
): Promise<void> {
  const response = await profileClient(options).v1["browser-profiles"][":profileId"][
    "login-sessions"
  ][":sessionId"].complete.$post({ param: { profileId, sessionId } });
  await responseData(response, "Could not complete login");
}

function profileClient(options: ClientOptions) {
  const baseUrl = options.baseUrl ?? headlessChatApiBaseUrl();
  return createOpenCompanyClient(baseUrl, {
    fetch: createHeadlessChatApiFetch({
      baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
}

async function responseData<T>(
  response: Response & { json(): Promise<{ data: T }> },
  fallback: string,
) {
  if (!response.ok) throw await profileResponseError(response, fallback);
  return (await response.json()).data;
}

async function profileResponseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message = typeof body?.error?.message === "string" ? body.error.message : null;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(
    `${message ?? `${fallback} (HTTP ${response.status}).`}${requestId ? ` (request ${requestId})` : ""}`,
  );
}
