// Called by: scripts/dev.mjs.
// Purpose: resolves Goat dev environment without letting public tunnels replace
// local WorkOS callbacks.

export function resolveGoatDevEnv({
  port = "3002",
  processEnv = process.env,
  tunnelEnv = {},
  goatHttpsEnv = {},
} = {}) {
  const localHttpAppUrl = `http://localhost:${port}`;
  const configuredAppUrl = configuredGoatAppUrl(processEnv, goatHttpsEnv);
  const goatAppUrl =
    trimmed(goatHttpsEnv.GOAT_NEXT_PUBLIC_APP_URL) ||
    trimmed(tunnelEnv.GOAT_NEXT_PUBLIC_APP_URL) ||
    trimmed(tunnelEnv.NEXT_PUBLIC_APP_URL) ||
    configuredAppUrl ||
    localHttpAppUrl;

  const localRedirectAppUrl =
    trimmed(goatHttpsEnv.GOAT_NEXT_PUBLIC_APP_URL) || configuredAppUrl || localHttpAppUrl;
  const goatRedirectUri =
    trimmed(goatHttpsEnv.GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI) ||
    configuredGoatRedirectUri(processEnv, goatHttpsEnv) ||
    `${localRedirectAppUrl}/auth/callback`;

  return {
    GOAT_NEXT_PUBLIC_APP_URL: goatAppUrl,
    GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI: goatRedirectUri,
    GOAT_LOCAL_BRIDGE_BASE_URL:
      processEnv.GOAT_LOCAL_BRIDGE_BASE_URL?.trim() || `http://127.0.0.1:${port}`,
    NEXT_PUBLIC_APP_URL: goatAppUrl,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: goatRedirectUri,
    WORKOS_REDIRECT_URI: goatRedirectUri,
    RUNNER_GOAT_TASK_WORKER_ENABLED: "true",
    RUNNER_ALLOWED_ORIGINS: appendCsvValues(
      processEnv.RUNNER_ALLOWED_ORIGINS,
      [goatAppUrl, tunnelEnv.NEXT_PUBLIC_APP_URL, tunnelEnv.GOAT_NEXT_PUBLIC_APP_URL].filter(
        Boolean,
      ),
    ),
    RUNNER_PREVIEW_BASE_DOMAIN:
      trimmed(processEnv.RUNNER_PREVIEW_BASE_DOMAIN) ||
      localPreviewBaseDomain(goatAppUrl, processEnv.RUNNER_PUBLIC_URL),
    RUNNER_PREVIEW_PROTOCOL:
      trimmed(processEnv.RUNNER_PREVIEW_PROTOCOL) ||
      previewProtocol(goatAppUrl, processEnv.RUNNER_PUBLIC_URL),
  };
}

function previewProtocol(goatAppUrl, runnerPublicUrl) {
  try {
    const appUrl = new URL(goatAppUrl);
    if (appUrl.hostname === "localhost") return appUrl.protocol === "https:" ? "https" : "http";
  } catch {
    // Fall through to the runner origin.
  }
  try {
    return new URL(runnerPublicUrl || "http://localhost:3040").protocol === "https:"
      ? "https"
      : "http";
  } catch {
    // Use the local HTTP default below.
  }
  return "http";
}

function localPreviewBaseDomain(goatAppUrl, runnerPublicUrl) {
  try {
    const appUrl = new URL(goatAppUrl);
    if (appUrl.protocol === "https:" && appUrl.hostname === "localhost") {
      return `preview.localhost:${appUrl.port || "443"}`;
    }
  } catch {}

  try {
    const runnerUrl = new URL(runnerPublicUrl || "http://localhost:3040");
    return `preview.localhost:${runnerUrl.port || (runnerUrl.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return "preview.localhost:3040";
  }
}

function configuredGoatAppUrl(env, goatHttpsEnv) {
  const configured = env.GOAT_NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) return null;
  if (configured.startsWith("https://localhost") && !goatHttpsEnv.GOAT_NEXT_PUBLIC_APP_URL) {
    return null;
  }
  return configured;
}

function configuredGoatRedirectUri(env, goatHttpsEnv) {
  const configured = env.GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim();
  if (!configured) return null;
  if (
    configured.startsWith("https://localhost") &&
    !goatHttpsEnv.GOAT_NEXT_PUBLIC_WORKOS_REDIRECT_URI
  ) {
    return null;
  }
  return configured;
}

function appendCsvValues(raw, values) {
  const existing = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const seen = new Set(existing);
  for (const value of values) {
    if (seen.has(value)) continue;
    existing.push(value);
    seen.add(value);
  }
  return existing.join(",");
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}
