import { createLogger } from "@opencompany/observability";
import type { RunnerEnv } from "./env";
import { armSandboxIdleTimeout, connectSandbox, type SandboxHandle } from "./sandbox";
import { loadSession } from "./session-lifecycle";

export type SessionPreviewLink = {
  url: string;
  port: number;
};

export type SessionPreview =
  | {
      available: true;
      url: string;
      port: number;
      previews: SessionPreviewLink[];
      sandboxId: string;
      detectedAt: string;
    }
  | {
      available: false;
      reason: "not_codex" | "no_sandbox" | "sandbox_not_found" | "no_http_ports";
      message: string;
    };

const logger = createLogger({ service: "opencompany-runner", runtime: "preview-url" });

const PREVIEW_PORT_PREFERENCES = [3000, 3001, 5173, 4173, 4321, 8000, 8080, 5000, 4000] as const;
const EXCLUDED_PREVIEW_PORTS = new Set([22, 47345, 49983, 50005]);
const PORT_SCAN_TIMEOUT_MS = 5_000;
const PORT_PROBE_TIMEOUT_MS = 3_000;

type PreviewSandbox = Pick<SandboxHandle, "commands" | "getHost" | "sandboxId">;

export async function resolveSessionPreviewUrl(input: {
  sessionId: string;
  workspaceId: string;
  env: RunnerEnv;
}): Promise<SessionPreview | null> {
  const row = await loadSession(input.sessionId);
  if (row.session.workspaceId !== input.workspaceId) return null;

  if (row.session.engine !== "codex") {
    return unavailable("not_codex", "Preview URLs are only available for Codex sessions.");
  }

  if (!row.session.e2bSandboxId) {
    return unavailable("no_sandbox", "No active sandbox has been attached to this session yet.");
  }

  const sandbox = await connectSandbox({ sandboxId: row.session.e2bSandboxId });
  if (!sandbox) {
    return unavailable("sandbox_not_found", "The session sandbox is no longer running.");
  }

  try {
    const previews = await detectSandboxHttpPreviews(sandbox);
    const preview = previews[0];
    if (!preview) {
      return unavailable(
        "no_http_ports",
        "No HTTP dev server is currently listening in the sandbox.",
      );
    }
    return {
      available: true,
      sandboxId: sandbox.sandboxId,
      detectedAt: new Date().toISOString(),
      previews,
      ...preview,
    };
  } finally {
    await armSandboxIdleTimeout(sandbox, input.env.e2bSandboxIdleTimeoutMs).catch((error) => {
      logger.warn("Failed to restore sandbox idle timeout after preview detection", {
        event: "opencompany.preview_idle_timeout_restore_failed",
        session_id: input.sessionId,
        sandbox_id: sandbox.sandboxId,
        error,
      });
    });
  }
}

export async function detectSandboxHttpPreview(
  sandbox: PreviewSandbox,
): Promise<SessionPreviewLink | null> {
  return (await detectSandboxHttpPreviews(sandbox))[0] ?? null;
}

export async function detectSandboxHttpPreviews(
  sandbox: PreviewSandbox,
): Promise<SessionPreviewLink[]> {
  const ports = await listListeningTcpPorts(sandbox);
  const previews: SessionPreviewLink[] = [];
  for (const port of orderPreviewPorts(ports)) {
    if (await probeHttpPort(sandbox, port)) {
      previews.push({ port, url: `https://${sandbox.getHost(port)}` });
    }
  }
  return previews;
}

export async function listListeningTcpPorts(sandbox: PreviewSandbox): Promise<number[]> {
  const result = await sandbox.commands.run("ss -H -ltn", { timeoutMs: PORT_SCAN_TIMEOUT_MS });
  return parseListeningTcpPorts(String(result.stdout ?? ""));
}

export function parseListeningTcpPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    const localAddress = columns[3];
    const port = localAddress ? portFromSocketAddress(localAddress) : null;
    if (port != null && isPreviewCandidatePort(port)) ports.add(port);
  }
  return [...ports];
}

export function orderPreviewPorts(ports: number[]): number[] {
  const unique = [...new Set(ports.filter(isPreviewCandidatePort))];
  return unique.toSorted((left, right) => {
    const leftPreference = previewPortPreference(left);
    const rightPreference = previewPortPreference(right);
    if (leftPreference !== rightPreference) return leftPreference - rightPreference;
    return left - right;
  });
}

async function probeHttpPort(sandbox: PreviewSandbox, port: number): Promise<boolean> {
  const result = await sandbox.commands
    .run(`curl -sS -i --max-time 1 http://127.0.0.1:${port}/ 2>/dev/null | head -c 2048 || true`, {
      timeoutMs: PORT_PROBE_TIMEOUT_MS,
    })
    .catch(() => ({ stdout: "" }));
  return isHttpProbeResponse(String(result.stdout ?? ""));
}

function isHttpProbeResponse(output: string) {
  const response = output.trimStart();
  if (!/^HTTP\/\d(?:\.\d)?\s+[1-5]\d\d\b/i.test(response)) return false;
  return !isE2bInternalAuthResponse(response);
}

function isE2bInternalAuthResponse(output: string) {
  const response = output.toLowerCase();
  return (
    response.includes("unauthorized access, please provide a valid access token") &&
    response.includes("method signing if supported")
  );
}

function portFromSocketAddress(value: string): number | null {
  const match = value.match(/(?::|\.)(\d+)$/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function isPreviewCandidatePort(port: number) {
  return port >= 1024 && port <= 65_535 && !EXCLUDED_PREVIEW_PORTS.has(port);
}

function previewPortPreference(port: number) {
  const index = PREVIEW_PORT_PREFERENCES.indexOf(port as (typeof PREVIEW_PORT_PREFERENCES)[number]);
  return index === -1 ? PREVIEW_PORT_PREFERENCES.length : index;
}

function unavailable(
  reason: Exclude<SessionPreview, { available: true }>["reason"],
  message: string,
) {
  return { available: false as const, reason, message };
}
