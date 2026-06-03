import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { loadEncryptionKey } from "@opencompany/crypto";

export type RunnerEnv = {
  databaseUrl: string;
  internalToken: string;
  streamTokenSecret: string;
  e2bApiKey: string;
  vercelAiGatewayApiKey: string;
  integrationCredentialEncryptionKey: Buffer;
  exaApiKey: string | undefined;
  xApiBearerToken: string | undefined;
  apifyApiToken?: string | undefined;
  supadataApiKey: string | undefined;
  ampApiKey: string | undefined;
  e2bTemplate: string | undefined;
  ampE2bTemplate: string | undefined;
  e2bSandboxIdleTimeoutMs: number;
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
    integrationCredentialEncryptionKey: requiredEncryptionKey(),
    exaApiKey: optionalEnv("EXA_API_KEY"),
    xApiBearerToken: optionalEnv("X_API_BEARER_TOKEN"),
    apifyApiToken: optionalEnv("APIFY_API_TOKEN"),
    supadataApiKey: optionalEnv("SUPADATA_API_KEY"),
    ampApiKey: optionalEnv("AMP_API_KEY"),
    e2bTemplate: process.env.OPENCOMPANY_E2B_TEMPLATE || undefined,
    ampE2bTemplate: optionalEnv("OPENCOMPANY_AMP_E2B_TEMPLATE"),
    e2bSandboxIdleTimeoutMs: optionalPositiveIntegerEnv("RUNNER_E2B_IDLE_TIMEOUT_MS", 30_000),
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
