import { createSign } from "node:crypto";

type InstallationToken = {
  token: string;
  expiresAt: number;
};

const cachedTokens = new Map<string, InstallationToken>();

// GitHub returns this when an installation token is valid but the App was never granted the
// permission for the attempted action (e.g. `gh issue create` / POST /repos/:o/:r/issues with no
// Issues:write). The raw stderr ("Resource not accessible by integration") is opaque, so we turn it
// into an actionable instruction the agent — or an operator reading logs — can act on directly.
const GITHUB_PERMISSION_ERROR_PATTERN = /resource not accessible by integration/i;

export function gitHubPermissionErrorHint(detail: string): string | null {
  if (!GITHUB_PERMISSION_ERROR_PATTERN.test(detail)) return null;
  return [
    "GitHub denied this action: the GitHub App installation lacks the required permission",
    '(403 "Resource not accessible by integration").',
    'If this is an Issues operation (e.g. creating an issue), grant the GitHub App "Issues: Read',
    "& write" + " and have the org installation re-approve the expanded permissions, then retry.",
  ].join(" ");
}

export async function getGitHubInstallationToken(
  installationId = process.env.GITHUB_APP_INSTALLATION_ID,
) {
  if (!hasGitHubWorkspaceAppEnv()) return null;
  if (!installationId) {
    throw new Error("GITHUB_APP_INSTALLATION_ID is required for managed GitHub workspace cloning.");
  }

  return getInstallationToken({
    installationId,
    appId: requiredEnv("GITHUB_APP_ID"),
    privateKey: requiredEnv("GITHUB_APP_PRIVATE_KEY"),
    cachePrefix: "workspace",
    purpose: "managed workspace",
    envNames: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"],
  });
}

export async function getGitHubWorkInstallationToken(input: {
  installationId: string;
  repositoryFullName?: string;
  repositoryFullNames?: string[];
}) {
  if (!hasGitHubIntegrationAppEnv()) return null;

  const repositoryFullNames = normalizeRepositoryFullNames(
    input.repositoryFullNames ?? (input.repositoryFullName ? [input.repositoryFullName] : []),
  );

  return getInstallationToken({
    installationId: input.installationId,
    appId: requiredEnv("GITHUB_INTEGRATION_APP_ID"),
    privateKey: requiredEnv("GITHUB_INTEGRATION_APP_PRIVATE_KEY"),
    cachePrefix: "integration",
    purpose: "work repository integration",
    envNames: ["GITHUB_INTEGRATION_APP_ID", "GITHUB_INTEGRATION_APP_PRIVATE_KEY"],
    repositoryFullNames,
  });
}

function normalizeRepositoryFullNames(names: string[]) {
  return [...new Set(names)].sort();
}

async function getInstallationToken(input: {
  installationId: string;
  repositoryFullNames?: string[];
  appId: string;
  privateKey: string;
  cachePrefix: string;
  purpose: string;
  envNames: [string, string];
}) {
  const repositoryFullNames = input.repositoryFullNames ?? [];
  const cacheScope = repositoryFullNames.length > 0 ? repositoryFullNames.join(",") : "*";
  const cacheKey = `${input.cachePrefix}:${input.installationId}:${cacheScope}`;
  const cachedToken = cachedTokens.get(cacheKey);
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.token;
  }

  const response = await fetch(
    `https://api.github.com/app/installations/${input.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${createAppJwt({
          appId: input.appId,
          privateKey: input.privateKey,
        })}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(repositoryFullNames.length > 0
        ? {
            body: JSON.stringify({
              repositories: repositoryFullNames.map(githubRepositoryName),
            }),
          }
        : {}),
    },
  );

  if (!response.ok) {
    const details = await response.text();
    if (response.status === 404) {
      throw new Error(
        [
          `GitHub ${input.purpose} installation ${input.installationId} is not accessible to the configured GitHub App.`,
          `Reconnect the GitHub integration or verify the runner and web app use the same ${input.envNames.join(
            "/",
          )} credentials.`,
          `GitHub response: ${details}`,
        ].join(" "),
      );
    }

    throw new Error(`GitHub installation token request failed with ${response.status}: ${details}`);
  }

  const result = (await response.json()) as { token?: string; expires_at?: string };
  if (!result.token) {
    throw new Error("GitHub did not return an installation token.");
  }

  cachedTokens.set(cacheKey, {
    token: result.token,
    expiresAt: result.expires_at
      ? new Date(result.expires_at).getTime()
      : Date.now() + 55 * 60 * 1000,
  });

  return result.token;
}

export async function createDraftPullRequest(input: {
  installationId?: string;
  repositoryFullName: string;
  title: string;
  head: string;
  base: string;
  body: string;
}) {
  const token = input.installationId
    ? await getGitHubWorkInstallationToken({
        installationId: input.installationId,
        repositoryFullName: input.repositoryFullName,
      })
    : await getGitHubInstallationToken();
  if (!token) {
    throw new Error("GitHub App credentials are required to create pull requests.");
  }

  return githubRequest<{ html_url?: string; number?: number }>({
    token,
    path: `/repos/${input.repositoryFullName}/pulls`,
    method: "POST",
    body: {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      draft: true,
    },
  });
}

async function githubRequest<T>(input: {
  token: string;
  path: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
}): Promise<T> {
  const response = await fetch(`https://api.github.com${input.path}`, {
    method: input.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
  });

  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 403) {
      const hint = gitHubPermissionErrorHint(detail);
      if (hint) throw new Error(hint);
    }
    throw new Error(`GitHub request failed with ${response.status}: ${detail}`);
  }

  return (await response.json()) as T;
}

function hasGitHubWorkspaceAppEnv() {
  return Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
}

function hasGitHubIntegrationAppEnv() {
  return Boolean(
    process.env.GITHUB_INTEGRATION_APP_ID && process.env.GITHUB_INTEGRATION_APP_PRIVATE_KEY,
  );
}

function githubRepositoryName(repositoryFullName: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName)) {
    throw new Error("Invalid GitHub repository name for installation token scope.");
  }
  return repositoryFullName.split("/")[1];
}

function createAppJwt(credentials: { appId: string; privateKey: string }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: credentials.appId,
    }),
  );
  const input = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(input)
    .sign(normalizePrivateKey(credentials.privateKey));

  return `${input}.${base64Url(signature)}`;
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for GitHub Brain sync.`);
  }
  return value;
}

function normalizePrivateKey(value: string) {
  return value.replace(/\\\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\\n/g, "\n");
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
