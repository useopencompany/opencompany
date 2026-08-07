// Called by: scripts/dev.mjs.
// Purpose: resolves Goat dev environment without letting public tunnels replace
// local WorkOS callbacks.

export function resolveDevEnv({
  port = "3002",
  processEnv = process.env,
  tunnelEnv = {},
  httpsEnv = {},
} = {}) {
  const localHttpAppUrl = `http://localhost:${port}`;
  const configured = configuredAppUrl(processEnv, httpsEnv);
  const appUrl =
    trimmed(httpsEnv.NEXT_PUBLIC_APP_URL) ||
    trimmed(tunnelEnv.NEXT_PUBLIC_APP_URL) ||
    configured ||
    localHttpAppUrl;

  const localRedirectAppUrl =
    trimmed(httpsEnv.NEXT_PUBLIC_APP_URL) || configured || localHttpAppUrl;
  const redirectUri =
    trimmed(httpsEnv.NEXT_PUBLIC_WORKOS_REDIRECT_URI) ||
    configuredRedirectUri(processEnv, httpsEnv) ||
    `${localRedirectAppUrl}/auth/callback`;

  return {
    NEXT_PUBLIC_APP_URL: appUrl,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: redirectUri,
    WORKOS_REDIRECT_URI: redirectUri,
    RUNNER_WORKERS_ENABLED: "true",
    RUNNER_ALLOWED_ORIGINS: appendCsvValues(
      processEnv.RUNNER_ALLOWED_ORIGINS,
      [appUrl, tunnelEnv.NEXT_PUBLIC_APP_URL].filter(Boolean),
    ),
    RUNNER_PREVIEW_BASE_DOMAIN:
      trimmed(processEnv.RUNNER_PREVIEW_BASE_DOMAIN) ||
      localPreviewBaseDomain(appUrl, processEnv.RUNNER_PUBLIC_URL),
    RUNNER_PREVIEW_PROTOCOL:
      trimmed(processEnv.RUNNER_PREVIEW_PROTOCOL) ||
      previewProtocol(appUrl, processEnv.RUNNER_PUBLIC_URL),
  };
}

function previewProtocol(appUrl, runnerPublicUrl) {
  try {
    const parsed = new URL(appUrl);
    if (parsed.hostname === "localhost") return parsed.protocol === "https:" ? "https" : "http";
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

function localPreviewBaseDomain(appUrl, runnerPublicUrl) {
  try {
    const parsed = new URL(appUrl);
    if (parsed.protocol === "https:" && parsed.hostname === "localhost") {
      return `preview.localhost:${parsed.port || "443"}`;
    }
  } catch {}

  try {
    const runnerUrl = new URL(runnerPublicUrl || "http://localhost:3040");
    return `preview.localhost:${runnerUrl.port || (runnerUrl.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return "preview.localhost:3040";
  }
}

function configuredAppUrl(env, httpsEnv) {
  const configured = env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) return null;
  if (configured.startsWith("https://localhost") && !httpsEnv.NEXT_PUBLIC_APP_URL) {
    return null;
  }
  return configured;
}

function configuredRedirectUri(env, httpsEnv) {
  const configured = env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim();
  if (!configured) return null;
  if (configured.startsWith("https://localhost") && !httpsEnv.NEXT_PUBLIC_WORKOS_REDIRECT_URI) {
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
