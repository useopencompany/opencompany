import type { CodexUsage } from "@opencompany/protocol";
import * as z from "zod";
import { CodexBackendError, createCodexTokenManager } from "./codex-backend-language-model";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const WindowSchema = z.object({
  used_percent: z.number().nonnegative(),
  reset_at: z.number().int().nonnegative().max(8_640_000_000_000),
  limit_window_seconds: z.number().int().positive(),
});
const RateLimitSchema = z.object({
  primary_window: WindowSchema.nullish(),
  secondary_window: WindowSchema.nullish(),
});
const UsageResponseSchema = z.object({
  account_id: z.string().nullish(),
  rate_limit: RateLimitSchema.nullish(),
  additional_rate_limits: z
    .array(
      z.object({
        limit_name: z.string().nullish(),
        metered_feature: z.string().nullish(),
        rate_limit: RateLimitSchema.nullish(),
      }),
    )
    .nullish(),
});

export async function fetchCodexUsage(input: {
  db: Parameters<typeof createCodexTokenManager>[0]["db"];
  userWorkosId: string;
  fetchImpl?: typeof fetch;
}): Promise<CodexUsage> {
  // Bound both usage reads and any OAuth refresh through the existing token lease.
  const signal = AbortSignal.timeout(20_000);
  const fetchImpl: typeof fetch = (request, init) =>
    (input.fetchImpl ?? fetch)(request, { ...init, signal, redirect: "error" });
  const tokenManager = createCodexTokenManager({
    ...input,
    fetchImpl,
    now: Date.now,
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
  let tokens = await tokenManager.getTokens(false);
  const read = () =>
    fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "ChatGPT-Account-Id": tokens.accountId,
        Accept: "application/json",
      },
      cache: "no-store",
    });
  let response = await read();
  if (response.status === 401) {
    await response.body?.cancel();
    tokens = await tokenManager.getTokens(true);
    response = await read();
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401) {
      throw new CodexBackendError(
        "needs_reauth",
        "Reconnect Codex to view subscription usage.",
        401,
      );
    }
    throw new CodexBackendError(
      "backend_error",
      response.status === 429
        ? "Codex usage refresh is rate limited. Try again in a minute."
        : "Codex usage is temporarily unavailable. Try again shortly.",
      503,
    );
  }
  const result = UsageResponseSchema.safeParse(await response.json());
  if (!result.success || (result.data.account_id && result.data.account_id !== tokens.accountId)) {
    throw new CodexBackendError(
      "backend_error",
      "Codex usage could not be read. Try again shortly.",
      502,
    );
  }
  return normalizeCodexUsage(result.data);
}

function normalizeCodexUsage(data: z.infer<typeof UsageResponseSchema>): CodexUsage {
  const windows: CodexUsage["windows"] = [];
  const append = (
    limits: z.infer<typeof RateLimitSchema> | null | undefined,
    id: string,
    name: string,
  ) => {
    for (const slot of ["primary_window", "secondary_window"] as const) {
      const window = limits?.[slot];
      if (!window) continue;
      windows.push({
        id: `${id}:${slot}`,
        label: [name, windowLabel(window.limit_window_seconds)].filter(Boolean).join(" "),
        usedPercent: Math.min(100, window.used_percent),
        resetsAt: new Date(window.reset_at * 1_000).toISOString(),
      });
    }
  };
  append(data.rate_limit, "codex", "");
  for (const [index, extra] of (data.additional_rate_limits ?? []).entries()) {
    append(
      extra.rate_limit,
      `extra:${index}`,
      extra.limit_name?.trim() || extra.metered_feature?.trim() || "Additional limit",
    );
  }
  return { windows, updatedAt: new Date().toISOString() };
}

function windowLabel(seconds: number): string {
  if (seconds === 604_800) return "Weekly";
  if (seconds === 86_400) return "Daily";
  if (seconds % 3_600 === 0) return `${seconds / 3_600}-hour`;
  if (seconds % 60 === 0) return `${seconds / 60}-minute`;
  return `${seconds}-second`;
}
