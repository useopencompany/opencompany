import { AUX_GATEWAY_MODEL_PRICING } from "@opencompany/billing";
import type { GatewayUsageEntry } from "@opencompany/memory/usage";
import { parseMemoryUsageReport } from "@opencompany/memory/usage";
import { createKnownSecretRedactor } from "./coding-agent-shared";
import { brokerActive, brokerBaseUrl, type RunnerEnv } from "./env";
import type { HostedToolUsage } from "./hosted-tools";
import { withBrokerDelegation } from "./llm-broker-tokens";
import { runSandboxTool, type SandboxHandle } from "./sandbox";

// Memory CLI runs are short (one retrieval mix of embedding + chat calls), so broker
// tokens get a fixed small TTL rather than tracking a tool timeout.
const MEMORY_BROKER_TOKEN_TTL_MS = 15 * 60 * 1000;

// Run the bundled `memory` CLI with the Vercel AI Gateway key injected ONLY into this subprocess,
// then surface its embedding/rerank/expansion usage for session billing.
//
// Why the model can't read the key: the runner builds the command from a parsed, shell-quoted argv
// (see sandbox.ts `memory` branch), so the agent only controls argv tokens and cannot append
// `; env` or otherwise break out; the env is set on the single E2B process; the CLI never prints
// env; and `redactOutput` scrubs the key from any stdout/stderr as a backstop. The usage report
// rides a stderr sentinel the CLI emits under --report-usage, which we parse and strip here so the
// model never sees it either.
export async function runMemoryTool(input: {
  sandbox: SandboxHandle;
  workdir: string;
  args: unknown;
  env: RunnerEnv;
  // Selects the personal layout so MEMORY_ROOT pins to the top-level memory/ tree.
  personal?: boolean;
  // Session context for the LLM broker. When present and the broker is active, the CLI
  // subprocess receives a short-lived broker token + broker base URL instead of the raw
  // Gateway key, and billing comes from the broker's settlement row — the stderr usage
  // report below is then display-only. Absent (or broker inactive) falls back to the
  // legacy direct-key injection.
  broker?: {
    sessionId: string;
    workspaceId: string;
    messageId: string | null;
    toolCallId: string | null;
  };
  onOutput?: (stream: "stdout" | "stderr", delta: string) => Promise<void> | void;
}): Promise<{ output: unknown; usage?: HostedToolUsage }> {
  const gatewayApiKey = input.env.vercelAiGatewayApiKey;

  const run = async (auth: {
    apiKeyValue: string;
    extraEnvs: Record<string, string>;
    brokered: boolean;
  }) => {
    const redact = createKnownSecretRedactor([auth.apiKeyValue, gatewayApiKey]);
    const raw = await runSandboxTool({
      sandbox: input.sandbox,
      workdir: input.workdir,
      name: "memory",
      args: input.args,
      personal: input.personal ?? false,
      envs: { VERCEL_AI_GATEWAY_API_KEY: auth.apiKeyValue, ...auth.extraEnvs },
      redactOutput: redact,
      ...(input.onOutput ? { onOutput: input.onOutput } : {}),
    });

    const record = (raw ?? {}) as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    const { entries, cleanedStdout: cleanedStderr } = parseMemoryUsageReport(stderr);

    const output = { ...record, stderr: cleanedStderr };
    const usage = buildMemoryUsage(entries, { brokered: auth.brokered });
    return usage ? { output, usage } : { output };
  };

  if (input.broker && brokerActive(input.env) && input.env.publicUrl) {
    return withBrokerDelegation(
      {
        sessionId: input.broker.sessionId,
        workspaceId: input.broker.workspaceId,
        messageId: input.broker.messageId,
        toolCallId: input.broker.toolCallId,
        toolName: "memory",
        provider: "gateway",
        ttlMs: MEMORY_BROKER_TOKEN_TTL_MS,
      },
      (minted) =>
        run({
          apiKeyValue: minted.token,
          extraEnvs: {
            MEMORY_GATEWAY_BASE_URL: brokerBaseUrl(input.env.publicUrl as string, "gateway"),
          },
          brokered: true,
        }),
    );
  }
  return run({ apiKeyValue: gatewayApiKey, extraEnvs: {}, brokered: false });
}

// Aggregate every Gateway call from one CLI invocation into a single billed row, mirroring how
// exa/opencode surface a HostedToolUsage. operation is "retrieval" because one memory query can mix
// embeddings + chat (expansion/rerank) calls; the per-call breakdown is preserved in rawUsage.
// Brokered runs are billed from the LLM broker's settlement row instead, so their stderr-reported
// usage carries zero cost (display-only).
function buildMemoryUsage(
  entries: GatewayUsageEntry[],
  options: { brokered: boolean } = { brokered: false },
): HostedToolUsage | undefined {
  if (entries.length === 0) return undefined;

  let costUsdMicros = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const entry of entries) {
    costUsdMicros += memoryEntryCostUsdMicros(entry);
    inputTokens += entry.inputTokens;
    outputTokens += entry.outputTokens;
  }

  return {
    provider: "vercel-ai-gateway",
    operation: "retrieval",
    costUsdMicros: options.brokered ? 0 : costUsdMicros,
    ...(options.brokered ? { costSource: "broker_metered" as const } : {}),
    rawUsage: {
      entries,
      inputTokens,
      outputTokens,
      calls: entries.length,
      ...(options.brokered ? { display_only: true } : {}),
    },
  };
}

// Prefer the Gateway-reported dollar cost; otherwise price the token counts via the fallback map.
function memoryEntryCostUsdMicros(entry: GatewayUsageEntry): number {
  if (entry.costUsd != null && entry.costUsd > 0) {
    return Math.round(entry.costUsd * 1_000_000);
  }
  const pricing = AUX_GATEWAY_MODEL_PRICING[entry.model];
  if (!pricing) return 0;
  const input = (entry.inputTokens / 1_000_000) * pricing.inputUsdMicrosPerMillion;
  const output = (entry.outputTokens / 1_000_000) * pricing.outputUsdMicrosPerMillion;
  return Math.round(input + output);
}

// Exported for unit tests: the pure usage aggregation, decoupled from the sandbox.
export const __test = { buildMemoryUsage, memoryEntryCostUsdMicros };
