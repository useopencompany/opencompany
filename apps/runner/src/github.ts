import { createSign } from "node:crypto";

type InstallationToken = {
  token: string;
  expiresAt: number;
};

const cachedTokens = new Map<string, InstallationToken>();

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

export async function getGitHubWorkInstallationToken(installationId: string) {
  if (!hasGitHubIntegrationAppEnv()) return null;

  return getInstallationToken({
    installationId,
    appId: requiredEnv("GITHUB_INTEGRATION_APP_ID"),
    privateKey: requiredEnv("GITHUB_INTEGRATION_APP_PRIVATE_KEY"),
    cachePrefix: "integration",
    purpose: "work repository integration",
    envNames: ["GITHUB_INTEGRATION_APP_ID", "GITHUB_INTEGRATION_APP_PRIVATE_KEY"],
  });
}

async function getInstallationToken(input: {
  installationId: string;
  appId: string;
  privateKey: string;
  cachePrefix: string;
  purpose: string;
  envNames: [string, string];
}) {
  const cacheKey = `${input.cachePrefix}:${input.installationId}`;
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
    ? await getGitHubWorkInstallationToken(input.installationId)
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
    throw new Error(`GitHub request failed with ${response.status}: ${await response.text()}`);
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
