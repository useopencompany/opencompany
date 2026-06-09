import type { GatewayUsageEntry } from "@opencompany/memory/usage";
import { parseMemoryUsageReport } from "@opencompany/memory/usage";
import { createKnownSecretRedactor } from "./coding-agent-shared";
import type { RunnerEnv } from "./env";
import type { HostedToolUsage } from "./hosted-tools";
import { runSandboxTool, type SandboxHandle } from "./sandbox";

// Pricing fallback for the memory CLI's model-backed retrieval, keyed by the Gateway model id used
// by packages/memory/src/retrieval/{gateway,providers}.ts. Values are USD-micros per million
// tokens. Used only when the Gateway does not report a dollar cost on the response; an unknown
// model (e.g. a custom MEMORY_*_MODEL override) prices to 0 rather than guessing.
const MEMORY_GATEWAY_PRICING: Record<
  string,
  { inputUsdMicrosPerMillion: number; outputUsdMicrosPerMillion: number }
> = {
  "openai/text-embedding-3-small": {
    inputUsdMicrosPerMillion: 20_000,
    outputUsdMicrosPerMillion: 0,
  },
  "openai/gpt-5.4-nano": {
    inputUsdMicrosPerMillion: 200_000,
    outputUsdMicrosPerMillion: 1_250_000,
  },
};

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
  onOutput?: (stream: "stdout" | "stderr", delta: string) => Promise<void> | void;
}): Promise<{ output: unknown; usage?: HostedToolUsage }> {
  const gatewayApiKey = input.env.vercelAiGatewayApiKey;
  const redact = createKnownSecretRedactor([gatewayApiKey]);

  const raw = await runSandboxTool({
    sandbox: input.sandbox,
    workdir: input.workdir,
    name: "memory",
    args: input.args,
    personal: input.personal ?? false,
    envs: { VERCEL_AI_GATEWAY_API_KEY: gatewayApiKey },
    redactOutput: redact,
    ...(input.onOutput ? { onOutput: input.onOutput } : {}),
  });

  const record = (raw ?? {}) as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const { entries, cleanedStdout: cleanedStderr } = parseMemoryUsageReport(stderr);

  const output = { ...record, stderr: cleanedStderr };
  const usage = buildMemoryUsage(entries);
  return usage ? { output, usage } : { output };
}

// Aggregate every Gateway call from one CLI invocation into a single billed row, mirroring how
// exa/opencode surface a HostedToolUsage. operation is "retrieval" because one memory query can mix
// embeddings + chat (expansion/rerank) calls; the per-call breakdown is preserved in rawUsage.
function buildMemoryUsage(entries: GatewayUsageEntry[]): HostedToolUsage | undefined {
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
    costUsdMicros,
    rawUsage: {
      entries,
      inputTokens,
      outputTokens,
      calls: entries.length,
    },
  };
}

// Prefer the Gateway-reported dollar cost; otherwise price the token counts via the fallback map.
function memoryEntryCostUsdMicros(entry: GatewayUsageEntry): number {
  if (entry.costUsd != null && entry.costUsd > 0) {
    return Math.round(entry.costUsd * 1_000_000);
  }
  const pricing = MEMORY_GATEWAY_PRICING[entry.model];
  if (!pricing) return 0;
  const input = (entry.inputTokens / 1_000_000) * pricing.inputUsdMicrosPerMillion;
  const output = (entry.outputTokens / 1_000_000) * pricing.outputUsdMicrosPerMillion;
  return Math.round(input + output);
}

// Exported for unit tests: the pure usage aggregation, decoupled from the sandbox.
export const __test = { buildMemoryUsage, memoryEntryCostUsdMicros };
