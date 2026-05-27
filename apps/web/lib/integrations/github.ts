import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { getAppUrl } from "@/lib/billing/stripe";

type GitHubInstallation = {
  id: number | string;
  account?: {
    login?: string;
    type?: string;
  };
};

type GitHubUserInstallations = {
  installations?: GitHubInstallation[];
};

type GitHubRepo = {
  id: number | string;
  full_name: string;
  default_branch?: string;
  private?: boolean;
};

type GitHubInstallationRepositories = {
  repositories?: GitHubRepo[];
};

const GITHUB_WORK_INTEGRATION_ENVS = [
  "GITHUB_INTEGRATION_APP_ID",
  "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
  "GITHUB_INTEGRATION_APP_SLUG",
  "GITHUB_INTEGRATION_APP_CLIENT_ID",
  "GITHUB_INTEGRATION_APP_CLIENT_SECRET",
  "GITHUB_INTEGRATION_STATE_SECRET",
  "INTEGRATION_CREDENTIAL_ENCRYPTION_KEY",
] as const;
const GITHUB_WORK_INSTALLATION_MANAGEMENT_ENVS = [
  "GITHUB_INTEGRATION_APP_ID",
  "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
] as const;

export type GitHubWorkRepository = {
  githubRepoId: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
};

export type GitHubIntegrationStatePayload = {
  workspaceId: string;
  userId: string;
  intent: "agent" | "settings";
  returnTo: string;
  installationId?: string;
  expiresAt: number;
  nonce: string;
};

export function createGitHubIntegrationState(
  input: Omit<GitHubIntegrationStatePayload, "expiresAt" | "nonce">,
) {
  const payload: GitHubIntegrationStatePayload = {
    ...input,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: crypto.randomUUID(),
  };
  const body = base64Url(JSON.stringify(payload));
  const signature = signStateBody(body);
  return `${body}.${signature}`;
}

export function verifyGitHubIntegrationState(state: string): GitHubIntegrationStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature) {
    throw new Error("Invalid GitHub integration state.");
  }

  const expected = signStateBody(body);
  if (!safeEqual(signature, expected)) {
    throw new Error("Invalid GitHub integration state signature.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGitHubIntegrationStatePayload(payload)) {
    throw new Error("Invalid GitHub integration state payload.");
  }
  if (payload.expiresAt < Date.now()) {
    throw new Error("GitHub integration state expired.");
  }

  return {
    ...payload,
    returnTo: sanitizeReturnTo(payload.returnTo),
  };
}

export function isGitHubWorkIntegrationConfigured() {
  return GITHUB_WORK_INTEGRATION_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

export function isGitHubWorkInstallationManagementConfigured() {
  return GITHUB_WORK_INSTALLATION_MANAGEMENT_ENVS.every((name) =>
    Boolean(process.env[name]?.trim()),
  );
}

export function buildGitHubInstallUrl(state: string) {
  const slug = requiredEnv("GITHUB_INTEGRATION_APP_SLUG");
  const url = new URL(`https://github.com/apps/${slug}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

export function buildGitHubUserAuthorizationUrl(state: string) {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", requiredEnv("GITHUB_INTEGRATION_APP_CLIENT_ID"));
  url.searchParams.set("redirect_uri", githubCallbackUrl());
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGitHubUserCode(code: string) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: requiredEnv("GITHUB_INTEGRATION_APP_CLIENT_ID"),
      client_secret: requiredEnv("GITHUB_INTEGRATION_APP_CLIENT_SECRET"),
      code,
      redirect_uri: githubCallbackUrl(),
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub user authorization failed with ${response.status}.`);
  }

  const result = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!result.access_token) {
    throw new Error(
      result.error_description ?? result.error ?? "GitHub did not return a user token.",
    );
  }

  return result.access_token;
}

export async function verifyGitHubUserInstallation(input: {
  userToken: string;
  installationId: string;
}) {
  const installations = await githubPaginatedRequest<GitHubUserInstallations, GitHubInstallation>({
    token: input.userToken,
    authScheme: "Bearer",
    path: "/user/installations",
    pickItems: (page: GitHubUserInstallations) => page.installations ?? [],
  });

  const installation = installations.find(
    (candidate) => String(candidate.id) === input.installationId,
  );
  if (!installation) {
    throw new Error("The GitHub installation was not available to the authorized user.");
  }

  return installation;
}

export async function getGitHubWorkInstallation(input: { installationId: string }) {
  return githubRequest<GitHubInstallation>({
    token: createAppJwt(),
    authScheme: "Bearer",
    path: `/app/installations/${input.installationId}`,
    method: "GET",
  });
}

export async function listGitHubWorkInstallationRepositories(input: { installationId: string }) {
  const token = await getGitHubWorkInstallationToken(input.installationId);
  const repositories = await githubPaginatedRequest<GitHubInstallationRepositories, GitHubRepo>({
    token,
    path: "/installation/repositories",
    pickItems: (page: GitHubInstallationRepositories) => page.repositories ?? [],
  });

  return toWorkRepositories(repositories);
}

export async function deleteGitHubWorkInstallation(input: { installationId: string }) {
  const response = await fetch(`https://api.github.com/app/installations/${input.installationId}`, {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${createAppJwt()}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (response.status === 404) {
    throw new GitHubInstallationNotFoundError(input.installationId, await response.text());
  }

  if (!response.ok) {
    throw new Error(
      `GitHub installation delete failed with ${response.status}: ${await response.text()}`,
    );
  }
}

export async function getGitHubWorkInstallationToken(installationId: string) {
  const result = await githubRequest<{ token?: string }>({
    token: createAppJwt(),
    authScheme: "Bearer",
    path: `/app/installations/${installationId}/access_tokens`,
    method: "POST",
  });

  if (!result.token) {
    throw new Error("GitHub did not return an installation token.");
  }

  return result.token;
}

export function appendIntegrationStatus(returnTo: string, status: "connected" | "error") {
  const url = new URL(sanitizeReturnTo(returnTo), getAppUrl());
  url.searchParams.set("integration", "github");
  url.searchParams.set("setup", status);
  return `${url.pathname}${url.search}`;
}

function githubCallbackUrl() {
  return `${getAppUrl()}/api/integrations/github/callback`;
}

export class GitHubInstallationNotFoundError extends Error {
  constructor(
    readonly installationId: string,
    readonly details: string,
  ) {
    super(`GitHub installation ${installationId} was not found for the configured GitHub App.`);
  }
}

function toWorkRepositories(repositories: GitHubRepo[]): GitHubWorkRepository[] {
  return repositories.map((repository) => ({
    githubRepoId: String(repository.id),
    fullName: repository.full_name,
    defaultBranch: repository.default_branch ?? "main",
    private: repository.private ?? true,
  }));
}

async function githubRequest<T>(input: {
  token: string;
  path: string;
  method: "GET" | "POST";
  authScheme?: "Bearer" | "token";
}): Promise<T> {
  const response = await fetch(`https://api.github.com${input.path}`, {
    method: input.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `${input.authScheme ?? "Bearer"} ${input.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed with ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as T;
}

async function githubPaginatedRequest<TPage, TItem>(input: {
  token: string;
  path: string;
  authScheme?: "Bearer" | "token";
  pickItems: (page: TPage) => TItem[];
}) {
  const items: TItem[] = [];
  let page = 1;

  while (true) {
    const separator = input.path.includes("?") ? "&" : "?";
    const result = await githubRequest<TPage>({
      token: input.token,
      path: `${input.path}${separator}per_page=100&page=${page}`,
      method: "GET",
      ...(input.authScheme ? { authScheme: input.authScheme } : {}),
    });
    const pageItems = input.pickItems(result);
    items.push(...pageItems);
    if (pageItems.length < 100) return items;
    page += 1;
  }
}

function isGitHubIntegrationStatePayload(value: unknown): value is GitHubIntegrationStatePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.workspaceId === "string" &&
    typeof record.userId === "string" &&
    (record.intent === "agent" || record.intent === "settings") &&
    typeof record.returnTo === "string" &&
    typeof record.expiresAt === "number" &&
    typeof record.nonce === "string" &&
    (record.installationId === undefined || typeof record.installationId === "string")
  );
}

function sanitizeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/settings/integrations";
  return value;
}

function signStateBody(body: string) {
  return createHmac("sha256", stateSecret()).update(body).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function stateSecret() {
  return requiredEnv("GITHUB_INTEGRATION_STATE_SECRET");
}

function createAppJwt() {
  const appId = requiredEnv("GITHUB_INTEGRATION_APP_ID");
  const privateKey = normalizePrivateKey(requiredEnv("GITHUB_INTEGRATION_APP_PRIVATE_KEY"));
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
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for GitHub work integrations.`);
  }
  return value;
}

function normalizePrivateKey(value: string) {
  return value.replace(/\\\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\\n/g, "\n");
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}
