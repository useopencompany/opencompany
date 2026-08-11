import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { loadEncryptionKey } from "@opencompany/crypto";

const DEFAULT_CODEX_TIMEOUT_MS = 60 * 60 * 1000;

export type RunnerEnv = {
  internalToken: string;
  streamTokenSecret: string;
  vercelAiGatewayApiKey: string;
  // Platform OpenAI key for codex_coder runs, used only server-side by the LLM broker
  // (llm-broker.ts) as the upstream credential for the "openai" provider. Never enters
  // the sandbox.
  openaiCodexApiKey: string | undefined;
  // Platform OpenAI key used only by the runner-hosted Goat voice dictation relay.
  // It is never sent to the browser; the Goat app mints short-lived runner tickets instead.
  openaiApiKey?: string | undefined;
  goatDictationRealtimeModel?: string | undefined;
  goatDictationFinalModel?: string | undefined;
  // Browser/sandbox-reachable runner origin. Render supplies RENDER_EXTERNAL_URL in hosted
  // services; RUNNER_PUBLIC_URL is the explicit local and non-Render override.
  runnerPublicUrl?: string | undefined;
  // Wildcard preview hostname routed to this runner, for example preview.goat.example.com.
  // Capability labels are prepended to this domain. A port may be included for local development.
  previewBaseDomain?: string | undefined;
  previewProtocol?: "http" | "https" | undefined;
  exaApiKey: string | undefined;
  goatBrowserEnabled: boolean;
  // Google OAuth client, shared by the Gmail, Google Calendar, and Google Drive integrations. The runner
  // needs it to refresh per-account access tokens against Google's token endpoint.
  googleOAuthClientId?: string | undefined;
  googleOAuthClientSecret?: string | undefined;
  // HubSpot OAuth client (same app as the goat web OAuth flow). HubSpot access
  // tokens are short-lived, so the runner refreshes them against HubSpot's
  // token endpoint before snapshot enrichment.
  hubspotOAuthClientId?: string | undefined;
  hubspotOAuthClientSecret?: string | undefined;
  codexE2bTemplate: string | undefined;
  blobReadWriteToken?: string | undefined;
  // Wall-clock ceiling for a single Codex engine turn: timeouts surface partial output but
  // never publish a pull request.
  codexTimeoutMs: number;
  codexModel: string;
  // Idle timeout for persistent Goat codex-chat sandboxes. Unlike per-task sandboxes (killed after
  // each run), a chat sandbox stays alive across turns so files and the app-server daemon survive;
  // on idle timeout E2B pauses it and Sandbox.connect auto-resumes on the next message.
  goatCodexChatIdleTimeoutMs: number;
  // Delivery-lease TTL for runner jobs. The lease heartbeats every 5s while a job runs, so this only
  // matters when the heartbeat stops (deploy, instance recycle, GC, or network blip).
  jobLeaseTtlMs: number;
  // Durable Goat chat turn lease TTL. Kept shorter than the ingestion-job delivery lease so a dead
  // worker's chat turn can be reclaimed quickly.
  goatCodexChatLeaseTtlMs?: number | undefined;
  // Explicit opt-in for Goat's durable task worker and runner-hosted tools.
  goatTaskWorkerEnabled: boolean;
  workerConcurrency: number;
  port: number;
  allowedOrigins: string[];
  instanceId: string;
};

export function loadEnv(): RunnerEnv {
  // Boot guards for env the runner consumes outside RunnerEnv: the e2b SDK reads
  // E2B_API_KEY from process.env itself, and @opencompany/db credential modules load the
  // integration credential encryption key lazily. Fail fast here instead of mid-request.
  requiredEnv("E2B_API_KEY");
  loadEncryptionKey();
  return {
    internalToken: requiredEnv("RUNNER_INTERNAL_TOKEN"),
    streamTokenSecret: requiredEnv("RUNNER_STREAM_TOKEN_SECRET"),
    vercelAiGatewayApiKey: requiredEnv("VERCEL_AI_GATEWAY_API_KEY"),
    openaiCodexApiKey: optionalEnv("OPENAI_CODEX_API_KEY"),
    openaiApiKey: optionalEnv("OPENAI_API_KEY"),
    goatDictationRealtimeModel: optionalEnv("GOAT_DICTATION_REALTIME_MODEL"),
    goatDictationFinalModel: optionalEnv("GOAT_DICTATION_FINAL_MODEL"),
    runnerPublicUrl: optionalEnv("RUNNER_PUBLIC_URL") ?? optionalEnv("RENDER_EXTERNAL_URL"),
    previewBaseDomain: optionalPreviewBaseDomainEnv(),
    previewProtocol: optionalPreviewProtocolEnv(),
    exaApiKey: optionalEnv("EXA_API_KEY"),
    goatBrowserEnabled: optionalBooleanEnv("RUNNER_GOAT_BROWSER_ENABLED", false),
    googleOAuthClientId: optionalEnv("GOOGLE_OAUTH_CLIENT_ID"),
    googleOAuthClientSecret: optionalEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
    hubspotOAuthClientId: optionalEnv("GOAT_HUBSPOT_CLIENT_ID"),
    hubspotOAuthClientSecret: optionalEnv("GOAT_HUBSPOT_CLIENT_SECRET"),
    codexE2bTemplate: optionalEnv("OPENCOMPANY_CODEX_E2B_TEMPLATE"),
    blobReadWriteToken: optionalEnv("BLOB_READ_WRITE_TOKEN"),
    codexTimeoutMs: optionalPositiveIntegerEnv("RUNNER_CODEX_TIMEOUT_MS", DEFAULT_CODEX_TIMEOUT_MS),
    codexModel: optionalEnv("RUNNER_CODEX_MODEL") ?? "gpt-5.6-sol",
    goatCodexChatIdleTimeoutMs: optionalPositiveIntegerEnv(
      "RUNNER_GOAT_CODEX_CHAT_IDLE_TIMEOUT_MS",
      5 * 60_000,
    ),
    jobLeaseTtlMs: optionalPositiveIntegerEnv("RUNNER_JOB_LEASE_TTL_MS", 300_000),
    goatCodexChatLeaseTtlMs: optionalPositiveIntegerEnv(
      "RUNNER_GOAT_CODEX_CHAT_LEASE_TTL_MS",
      90_000,
    ),
    goatTaskWorkerEnabled: optionalBooleanEnv("RUNNER_GOAT_TASK_WORKER_ENABLED", false),
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

function optionalPreviewProtocolEnv() {
  const value = optionalEnv("RUNNER_PREVIEW_PROTOCOL");
  if (!value) return undefined;
  if (value === "http" || value === "https") return value;
  throw new Error("RUNNER_PREVIEW_PROTOCOL must be http or https.");
}

function optionalPreviewBaseDomainEnv() {
  const value = optionalEnv("RUNNER_PREVIEW_BASE_DOMAIN");
  if (!value) return undefined;
  if (value.includes("://") || value.includes("/")) {
    throw new Error("RUNNER_PREVIEW_BASE_DOMAIN must be a hostname without a scheme or path.");
  }
  try {
    const url = new URL(`http://${value}`);
    if (!url.hostname || url.username || url.password) throw new Error("invalid hostname");
  } catch {
    throw new Error("RUNNER_PREVIEW_BASE_DOMAIN must be a valid hostname with an optional port.");
  }
  return value.toLowerCase();
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
