// Offline model comparison for the Brain ingestion agent.
//
// Replays real (already-succeeded) GitHub ingest jobs against candidate models
// and reports steps / tool calls / cost per job. Everything stays local: the
// brain is materialized into a temp dir (DB reads only), the agent loop runs
// against that copy, and nothing is synced back. The only external calls are
// the model requests through the Vercel AI Gateway.
//
// Usage:
//   infisical run --env=prod --path=/release -- \
//     sh -c 'DATABASE_URL="$PRODUCTION_DATABASE_URL" RUNNER_DATABASE_URL="$PRODUCTION_DATABASE_URL" \
//       VERCEL_AI_GATEWAY_API_KEY=<key> npx tsx apps/runner/scripts/ingest-model-bench.ts'
//
// Flags via env:
//   BENCH_MODELS   comma-separated gateway model ids (default: kimi, haiku, sonnet)
//   BENCH_JOBS     number of fixture jobs (default 3)
//   BENCH_OUT      output JSON path (default .context/ingest-model-bench.json)

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isNormalizedGitHubActivitySourceItem } from "@opencompany/brain";
import { getGoatBrainCliSource } from "@opencompany/brain/cli-bundle";
import { materializeGoatBrainFilesToRoot } from "@opencompany/db/brain-files";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db";
import {
  buildGitHubActivityAgentIngestPrompt,
  buildGoatBrainFolderInventoryPrompt,
  GITHUB_ACTIVITY_INGEST_SYSTEM_PROMPT,
  runIngestAgentLoop,
} from "../src/goat-brain-agent-ingest";

const MODELS = (
  process.env.BENCH_MODELS ??
  "moonshotai/kimi-k2.6,anthropic/claude-haiku-4.5,anthropic/claude-sonnet-5"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const JOB_COUNT = Number(process.env.BENCH_JOBS ?? "3");
const OUT_PATH = process.env.BENCH_OUT ?? ".context/ingest-model-bench.json";

const gatewayApiKey = process.env.VERCEL_AI_GATEWAY_API_KEY;
if (!gatewayApiKey) throw new Error("VERCEL_AI_GATEWAY_API_KEY is required");

type Fixture = {
  jobId: string;
  brainRef: string;
  userWorkosId: string;
  sourceRef: string;
  prodSteps: number | null;
  prodCostUsdMicros: number | null;
  item: Parameters<typeof buildGitHubActivityAgentIngestPrompt>[0];
};

async function loadFixtures(): Promise<Fixture[]> {
  const db = getDb();
  const rows = await db.execute(sql`
    select j.id as job_id,
      j.brain_ref,
      j.user_workos_id,
      s.source_ref,
      s.normalized_payload,
      (j.result->'trace'->>'steps')::int as prod_steps,
      (j.result->'trace'->'budget'->>'totalCostUsdMicros')::bigint as prod_cost_usd_micros
    from goat.brain_ingest_jobs j
    join goat.brain_source_items s on s.id = j.source_item_id
    where j.status = 'succeeded'
      and j.result->'trace'->>'model' = 'moonshotai/kimi-k2.6'
      and j.source_provider = 'github'
      and j.brain_ref is not null
      and j.created_at > now() - interval '7 days'
    order by j.created_at desc
    limit ${JOB_COUNT * 2}
  `);
  const fixtures: Fixture[] = [];
  for (const row of rows.rows as Record<string, unknown>[]) {
    const payload = row.normalized_payload;
    if (!isNormalizedGitHubActivitySourceItem(payload)) continue;
    fixtures.push({
      jobId: String(row.job_id),
      brainRef: String(row.brain_ref),
      userWorkosId: String(row.user_workos_id),
      sourceRef: String(row.source_ref),
      prodSteps: row.prod_steps === null ? null : Number(row.prod_steps),
      prodCostUsdMicros:
        row.prod_cost_usd_micros === null ? null : Number(row.prod_cost_usd_micros),
      item: payload,
    });
    if (fixtures.length >= JOB_COUNT) break;
  }
  return fixtures;
}

type RunResult = {
  jobId: string;
  model: string;
  steps: number;
  toolCalls: number;
  mutations: number;
  skipped: boolean;
  costUsdMicros: number;
  modelCostUsdMicros: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  durationMs: number;
  finalTextPreview: string;
  error?: string;
};

async function runOne(fixture: Fixture, model: string): Promise<RunResult> {
  const db = getDb();
  const root = await mkdtemp(path.join(os.tmpdir(), "goat-ingest-bench-"));
  const startedAt = Date.now();
  try {
    await materializeGoatBrainFilesToRoot({
      brainRef: fixture.brainRef,
      root,
      cliSource: getGoatBrainCliSource(),
      db,
    });
    const folderPrompt = await buildGoatBrainFolderInventoryPrompt(root);
    const basePrompt = buildGitHubActivityAgentIngestPrompt(fixture.item);
    const prompt = folderPrompt ? `${folderPrompt}\n\n${basePrompt}` : basePrompt;
    const loop = await runIngestAgentLoop({
      root,
      cliPath: path.join(root, "goat-brain.mjs"),
      gatewayApiKey: gatewayApiKey as string,
      userWorkosId: fixture.userWorkosId,
      brainRef: fixture.brainRef,
      model,
      ingestJobId: `bench_${fixture.jobId}_${model.replaceAll("/", "-")}`,
      system: GITHUB_ACTIVITY_INGEST_SYSTEM_PROMPT,
      prompt,
    });
    return {
      jobId: fixture.jobId,
      model,
      steps: loop.steps,
      toolCalls: loop.toolCalls,
      mutations: loop.mutations,
      skipped: loop.mutations === 0,
      costUsdMicros: loop.budget.totalCostUsdMicros,
      modelCostUsdMicros: loop.budget.modelCostUsdMicros,
      inputTokens: loop.usage.inputTokens,
      outputTokens: loop.usage.outputTokens,
      cacheReadInputTokens: loop.usage.cacheReadInputTokens,
      cacheWriteInputTokens: loop.usage.cacheWriteInputTokens,
      durationMs: Date.now() - startedAt,
      finalTextPreview: loop.finalText.slice(0, 200),
    };
  } catch (error) {
    return {
      jobId: fixture.jobId,
      model,
      steps: 0,
      toolCalls: 0,
      mutations: 0,
      skipped: true,
      costUsdMicros: 0,
      modelCostUsdMicros: 0,
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      durationMs: Date.now() - startedAt,
      finalTextPreview: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const fixtures = await loadFixtures();
if (fixtures.length === 0) throw new Error("No GitHub kimi fixtures found in the last 7 days.");
console.log(
  `Bench: ${fixtures.length} fixture jobs x ${MODELS.length} models (${MODELS.join(", ")})`,
);
for (const f of fixtures) {
  console.log(
    `  fixture ${f.jobId} (${f.sourceRef}) prod: ${f.prodSteps} steps, ${((f.prodCostUsdMicros ?? 0) / 10_000).toFixed(1)}c`,
  );
}

const results: RunResult[] = [];
for (const fixture of fixtures) {
  for (const model of MODELS) {
    console.log(`\n>>> job ${fixture.jobId} on ${model} ...`);
    const result = await runOne(fixture, model);
    results.push(result);
    console.log(
      result.error
        ? `    ERROR: ${result.error}`
        : `    ${result.steps} steps, ${result.toolCalls} tool calls, ${result.mutations} mutations, ` +
            `${(result.costUsdMicros / 10_000).toFixed(2)}c, ${(result.durationMs / 1000).toFixed(0)}s`,
    );
  }
}

console.log("\n=== Summary (cents/job) ===");
console.table(
  results.map((r) => ({
    job: r.jobId.slice(0, 12),
    model: r.model,
    steps: r.steps,
    tools: r.toolCalls,
    mut: r.mutations,
    cost_c: (r.costUsdMicros / 10_000).toFixed(2),
    in_ktok: r.inputTokens === null ? null : Math.round(r.inputTokens / 1000),
    cache_r_ktok:
      r.cacheReadInputTokens === null ? null : Math.round(r.cacheReadInputTokens / 1000),
    out_ktok: r.outputTokens === null ? null : Math.round(r.outputTokens / 1000),
    secs: Math.round(r.durationMs / 1000),
    err: r.error ? r.error.slice(0, 40) : "",
  })),
);

await writeFile(OUT_PATH, JSON.stringify({ fixtures, results }, null, 2));
console.log(`\nWrote ${OUT_PATH}`);
await closeDb();
