// Called by: scripts/dev.mjs.
// Purpose: resolves the web dev environment without letting public tunnels replace
// local WorkOS callbacks.

export function resolveWebDevEnv({
  port = "3002",
  processEnv = process.env,
  tunnelEnv = {},
  webHttpsEnv = {},
} = {}) {
  const localHttpAppUrl = `http://localhost:${port}`;
  const configuredAppUrl = configuredWebAppUrl(processEnv, webHttpsEnv);
  const webAppUrl =
    trimmed(webHttpsEnv.OPENCOMPANY_NEXT_PUBLIC_APP_URL) ||
    trimmed(tunnelEnv.OPENCOMPANY_NEXT_PUBLIC_APP_URL) ||
    trimmed(tunnelEnv.NEXT_PUBLIC_APP_URL) ||
    configuredAppUrl ||
    localHttpAppUrl;

  const localRedirectAppUrl =
    trimmed(webHttpsEnv.OPENCOMPANY_NEXT_PUBLIC_APP_URL) || configuredAppUrl || localHttpAppUrl;
  const webRedirectUri =
    trimmed(webHttpsEnv.OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI) ||
    configuredWebRedirectUri(processEnv, webHttpsEnv) ||
    `${localRedirectAppUrl}/auth/callback`;

  return {
    ...(trimmed(webHttpsEnv.OPENCOMPANY_NEXT_PUBLIC_APP_URL)
      ? { NODE_USE_SYSTEM_CA: trimmed(processEnv.NODE_USE_SYSTEM_CA) || "1" }
      : {}),
    OPENCOMPANY_NEXT_PUBLIC_APP_URL: webAppUrl,
    OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI: webRedirectUri,
    NEXT_PUBLIC_APP_URL: webAppUrl,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: webRedirectUri,
    WORKOS_REDIRECT_URI: webRedirectUri,
    RUNNER_OPENCOMPANY_TASK_WORKER_ENABLED: "true",
    RUNNER_ALLOWED_ORIGINS: appendCsvValues(
      processEnv.RUNNER_ALLOWED_ORIGINS,
      [webAppUrl, tunnelEnv.NEXT_PUBLIC_APP_URL, tunnelEnv.OPENCOMPANY_NEXT_PUBLIC_APP_URL].filter(
        Boolean,
      ),
    ),
    RUNNER_PREVIEW_BASE_DOMAIN:
      trimmed(processEnv.RUNNER_PREVIEW_BASE_DOMAIN) ||
      localPreviewBaseDomain(webAppUrl, processEnv.RUNNER_PUBLIC_URL),
    RUNNER_PREVIEW_PROTOCOL:
      trimmed(processEnv.RUNNER_PREVIEW_PROTOCOL) ||
      previewProtocol(webAppUrl, processEnv.RUNNER_PUBLIC_URL),
  };
}

function previewProtocol(webAppUrl, runnerPublicUrl) {
  try {
    const appUrl = new URL(webAppUrl);
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

function localPreviewBaseDomain(webAppUrl, runnerPublicUrl) {
  try {
    const appUrl = new URL(webAppUrl);
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

function configuredWebAppUrl(env, webHttpsEnv) {
  const configured = env.OPENCOMPANY_NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) return null;
  if (configured.startsWith("https://localhost") && !webHttpsEnv.OPENCOMPANY_NEXT_PUBLIC_APP_URL) {
    return null;
  }
  return configured;
}

function configuredWebRedirectUri(env, webHttpsEnv) {
  const configured = env.OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim();
  if (!configured) return null;
  if (
    configured.startsWith("https://localhost") &&
    !webHttpsEnv.OPENCOMPANY_NEXT_PUBLIC_WORKOS_REDIRECT_URI
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
