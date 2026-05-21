import { createSign } from "node:crypto";

type InstallationToken = {
  token: string;
  expiresAt: number;
};

let cachedToken: InstallationToken | null = null;

export async function getGitHubInstallationToken() {
  if (!hasGitHubAppEnv()) return null;
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.token;
  }

  const installationId = requiredEnv("GITHUB_APP_INSTALLATION_ID");
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${createAppJwt()}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub installation token request failed with ${response.status}: ${await response.text()}`);
  }

  const result = (await response.json()) as { token?: string; expires_at?: string };
  if (!result.token) {
    throw new Error("GitHub did not return an installation token.");
  }

  cachedToken = {
    token: result.token,
    expiresAt: result.expires_at ? new Date(result.expires_at).getTime() : Date.now() + 55 * 60 * 1000,
  };

  return result.token;
}

function hasGitHubAppEnv() {
  return Boolean(
    process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_INSTALLATION_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY,
  );
}

function createAppJwt() {
  const appId = requiredEnv("GITHUB_APP_ID");
  const privateKey = normalizePrivateKey(requiredEnv("GITHUB_APP_PRIVATE_KEY"));
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  );
  const input = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(input).sign(privateKey);

  return `${input}.${base64Url(signature)}`;
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for GitHub workspace cloning.`);
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
