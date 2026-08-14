"use client";

import { type BillingBalanceDto, createApiClient } from "@opencompany/protocol";
import { createHeadlessChatApiFetch, headlessChatApiBaseUrl } from "./headless-chat-api";

type ClientOptions = {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

export async function getHeadlessBillingBalance(
  options: ClientOptions = {},
): Promise<BillingBalanceDto> {
  const baseUrl = options.baseUrl ?? headlessChatApiBaseUrl();
  const client = createApiClient(baseUrl, {
    fetch: createHeadlessChatApiFetch({
      baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  });
  const response = await client.v1.billing.balance.$get();
  if (!response.ok) throw await billingResponseError(response);
  return (await response.json()).data;
}

async function billingResponseError(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; requestId?: unknown };
  } | null;
  const message =
    typeof body?.error?.message === "string"
      ? body.error.message
      : `Could not load billing balance (HTTP ${response.status}).`;
  const requestId = typeof body?.error?.requestId === "string" ? body.error.requestId : null;
  return new Error(`${message}${requestId ? ` (request ${requestId})` : ""}`);
}
