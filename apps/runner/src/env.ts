import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { loadEncryptionKey } from "@opencompany/crypto";

const DEFAULT_CODEX_TIMEOUT_MS = 60 * 60 * 1000;

export type RunnerEnv = {
  databaseUrl: string;
  internalToken: string;
  streamTokenSecret: string;
  e2bApiKey: string;
  vercelAiGatewayApiKey: string;
  // Platform OpenAI key for codex_coder runs, used only server-side by the LLM broker
  // (llm-broker.ts) as the upstream credential for the "openai" provider. Never enters
  // the sandbox.
  openaiCodexApiKey: string | undefined;
  // Public base URL of this runner (Render's RENDER_EXTERNAL_URL, or
  // RUNNER_LLM_BROKER_PUBLIC_URL to override). Sandboxed CLIs reach the LLM broker
  // through it. Unset (local dev, where E2B cloud sandboxes cannot reach a laptop)
  // disables the broker and falls back to direct provider-key injection. Deliberately
  // NOT the web-side RUNNER_PUBLIC_URL: the runner loads the repo-root .env, where that
  // var points at localhost in local dev and would wrongly activate the broker.
  publicUrl: string | undefined;
  // Kill switch for the LLM broker: set RUNNER_LLM_BROKER_ENABLED=false to revert to
  // direct key injection without a deploy.
  llmBrokerEnabled: boolean;
  integrationCredentialEncryptionKey: Buffer;
  exaApiKey: string | undefined;
  xApiBearerToken: string | undefined;
  apifyApiToken?: string | undefined;
  supadataApiKey: string | undefined;
  ampApiKey: string | undefined;
  // Google OAuth client, shared by the Gmail, Google Calendar, and Google Drive integrations. The runner
  // needs it to refresh per-account access tokens against Google's token endpoint.
  googleOAuthClientId?: string | undefined;
  googleOAuthClientSecret?: string | undefined;
  e2bTemplate: string | undefined;
  ampE2bTemplate: string | undefined;
  codexE2bTemplate: string | undefined;
  e2bSandboxIdleTimeoutMs: number;
  blobReadWriteToken?: string | undefined;
  // Wall-clock ceiling for a single opencode_coder delegation. Large monorepo tasks routinely
  // exceed the old hard 10 minutes; tunable per environment. On timeout the run no longer throws
  // away its work — the partial diff + resumable opencode session id are surfaced (opencode-tool.ts).
  // The job lease heartbeats while the command runs, so its TTL does not need to match this ceiling.
  opencodeTimeoutMs: number;
  // Wall-clock ceiling for a single Codex engine turn or codex_coder delegation. Mirrors
  // opencode timeout behavior: timeouts surface partial output but never publish a pull request.
  codexTimeoutMs: number;
  codexModel: string;
  // Feature flag for the persistent Codex app-server runner path. Disabled by default while the
  // existing `codex exec --json` path remains the production fallback.
  codexAppServerEnabled: boolean;
  // Kill switch for the model-based deferred-tool argument repair layer (Layer 3). Deterministic
  // validation + coercion always run; this only gates the small-model fallback. Default on.
  toolArgRepairEnabled: boolean;
  // Delivery-lease TTL for runner jobs. The lease heartbeats every 5s while a job runs, so this only
  // matters when the heartbeat stops (deploy, instance recycle, GC, network blip). The old 90s was
  // shorter than such gaps during a long blocking tool call, letting another instance re-claim the
  // job and replay the whole turn (double model + opencode billing). Sized to absorb a normal deploy.
  jobLeaseTtlMs: number;
  // Hard ceiling on how many times a job may be re-claimed while its execution (run) lease is busy
  // elsewhere. Lease-busy re-claims are normally deferred indefinitely; this caps the runaway case
  // (one job hit 17) by giving up once the in-flight run clearly owns the message.
  jobMaxLeaseBusyAttempts: number;
  workerConcurrency: number;
  port: number;
  allowedOrigins: string[];
  instanceId: string;
};

export function loadEnv(): RunnerEnv {
  return {
    databaseUrl: requiredEnv("DATABASE_URL"),
    internalToken: requiredEnv("RUNNER_INTERNAL_TOKEN"),
    streamTokenSecret: requiredEnv("RUNNER_STREAM_TOKEN_SECRET"),
    e2bApiKey: requiredEnv("E2B_API_KEY"),
    vercelAiGatewayApiKey: requiredEnv("VERCEL_AI_GATEWAY_API_KEY"),
    openaiCodexApiKey: optionalEnv("OPENAI_CODEX_API_KEY"),
    publicUrl: optionalEnv("RUNNER_LLM_BROKER_PUBLIC_URL") ?? optionalEnv("RENDER_EXTERNAL_URL"),
    llmBrokerEnabled: optionalBooleanEnv("RUNNER_LLM_BROKER_ENABLED", true),
    integrationCredentialEncryptionKey: requiredEncryptionKey(),
    exaApiKey: optionalEnv("EXA_API_KEY"),
    xApiBearerToken: optionalEnv("X_API_BEARER_TOKEN"),
    apifyApiToken: optionalEnv("APIFY_API_TOKEN"),
    supadataApiKey: optionalEnv("SUPADATA_API_KEY"),
    ampApiKey: optionalEnv("AMP_API_KEY"),
    googleOAuthClientId: optionalEnv("GOOGLE_OAUTH_CLIENT_ID"),
    googleOAuthClientSecret: optionalEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    e2bTemplate: process.env.OPENCOMPANY_E2B_TEMPLATE || undefined,
    ampE2bTemplate: optionalEnv("OPENCOMPANY_AMP_E2B_TEMPLATE"),
    codexE2bTemplate: optionalEnv("OPENCOMPANY_CODEX_E2B_TEMPLATE"),
    e2bSandboxIdleTimeoutMs: optionalPositiveIntegerEnv("RUNNER_E2B_IDLE_TIMEOUT_MS", 30_000),
    blobReadWriteToken: optionalEnv("BLOB_READ_WRITE_TOKEN"),
    opencodeTimeoutMs: optionalPositiveIntegerEnv("RUNNER_OPENCODE_TIMEOUT_MS", 1_200_000),
    codexTimeoutMs: optionalPositiveIntegerEnv("RUNNER_CODEX_TIMEOUT_MS", DEFAULT_CODEX_TIMEOUT_MS),
    codexModel: optionalEnv("RUNNER_CODEX_MODEL") ?? "gpt-5.5",
    codexAppServerEnabled: optionalBooleanEnv("RUNNER_CODEX_APP_SERVER_ENABLED", false),
    toolArgRepairEnabled: optionalBooleanEnv("RUNNER_TOOL_ARG_REPAIR_ENABLED", true),
    jobLeaseTtlMs: optionalPositiveIntegerEnv("RUNNER_JOB_LEASE_TTL_MS", 300_000),
    jobMaxLeaseBusyAttempts: optionalPositiveIntegerEnv("RUNNER_JOB_MAX_LEASE_BUSY_ATTEMPTS", 10),
    // Max parallel sessions this instance runs. Sessions are I/O-bound (mostly waiting on
    // model token streaming + remote E2B sandboxes), so this is bounded by the single
    // event loop, the E2B concurrent-sandbox quota, and model-gateway rate limits — not
    // CPU/RAM. The DB pool (RUNNER_DB_POOL_MAX) must comfortably exceed this. Scale past one
    // instance's ceiling with Render `numInstances`; the job + run leases make that safe.
    workerConcurrency: optionalPositiveIntegerEnv("RUNNER_WORKER_CONCURRENCY", 8),
    port: Number(process.env.PORT ?? "3040"),
    allowedOrigins: (process.env.RUNNER_ALLOWED_ORIGINS ?? "http://localhost:3000")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    instanceId: optionalEnv("RUNNER_INSTANCE_ID") ?? defaultInstanceId(),
  };
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requiredEncryptionKey() {
  return loadEncryptionKey();
}

function optionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function optionalBooleanEnv(name: string, fallback: boolean) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be a boolean (true/false/1/0).`);
}

function optionalPositiveIntegerEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function defaultInstanceId() {
  return `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

// Whether sandboxed CLIs route their model calls through the runner's LLM broker. Both
// conditions matter: without a public URL the sandbox cannot reach the broker (local
// dev), and the env flag is the no-deploy kill switch.
export function brokerActive(env: Pick<RunnerEnv, "publicUrl" | "llmBrokerEnabled">): boolean {
  return env.llmBrokerEnabled && Boolean(env.publicUrl);
}

// Base URL the sandbox-side CLI config points at for a given broker provider.
export function brokerBaseUrl(publicUrl: string, provider: "gateway" | "openai"): string {
  return `${publicUrl.replace(/\/+$/, "")}/broker/${provider}/v1`;
}
