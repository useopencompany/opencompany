import { createHmac, createSign, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { integrationResources, integrations } from "@opencompany/db/schema";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { getAppUrl } from "../app-url";

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

export type GitHubRepository = {
  githubRepoId: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
};

export type GitHubConnectedInstallation = {
  installationId: string;
  accountName: string | null;
};

export class GitHubApiError extends Error {
  readonly status: number;
  readonly operation: "installation_token" | "request";

  constructor(status: number, operation: "installation_token" | "request" = "request") {
    super(`GitHub API request failed with ${status}.`);
    this.name = "GitHubApiError";
    this.status = status;
    this.operation = operation;
  }
}

export type GitHubProviderState = {
  provider: "github";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountName: string | null;
  statusReason: string | null;
};

export type GitHubIntegrationStatePayload = {
  userWorkosId: string;
  // GitHub App installations are workspace-owned: the workspace the connecting
  // admin was acting in when the flow started.
  workspaceId: string;
  returnTo: string;
  installationId?: string;
  expiresAt: number;
  nonce: string;
};

const GITHUB_PROVIDER = "github" as const;
const GITHUB_REPOSITORY_RESOURCE_TYPE = "repository";
const INCOMPLETE_SYNC_STATUS_REASON = "GitHub integration sync has not completed.";
const GITHUB_WORK_INTEGRATION_ENVS = [
  "GITHUB_INTEGRATION_APP_ID",
  "GITHUB_INTEGRATION_APP_PRIVATE_KEY",
  "GITHUB_INTEGRATION_APP_SLUG",
  "GITHUB_INTEGRATION_APP_CLIENT_ID",
  "GITHUB_INTEGRATION_APP_CLIENT_SECRET",
  "GITHUB_INTEGRATION_STATE_SECRET",
] as const;

export async function getGitHubIntegrationState(workspaceId: string): Promise<GitHubProviderState> {
  const [row] = await getDb()
    .select({
      id: integrations.id,
      status: integrations.status,
      accountName: integrations.accountName,
      statusReason: integrations.statusReason,
    })
    .from(integrations)
    .where(
      and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, GITHUB_PROVIDER)),
    )
    .orderBy(desc(integrations.updatedAt))
    .limit(1);

  if (!row || row.status === "disconnected") {
    return {
      provider: GITHUB_PROVIDER,
      connected: false,
      status: "not_connected",
      integrationId: null,
      accountName: null,
      statusReason: null,
    };
  }

  return {
    provider: GITHUB_PROVIDER,
    connected: row.status === "connected",
    status: row.status,
    integrationId: row.id,
    accountName: row.accountName,
    statusReason: row.statusReason,
  };
}

export async function listConnectedGitHubInstallations(
  workspaceId: string,
): Promise<GitHubConnectedInstallation[]> {
  const rows = await getDb()
    .select({
      installationId: integrations.externalId,
      accountName: integrations.accountName,
      status: integrations.status,
    })
    .from(integrations)
    .where(
      and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, GITHUB_PROVIDER)),
    )
    .orderBy(desc(integrations.updatedAt));

  return rows.flatMap((row) => {
    const installationId = row.installationId?.trim();
    if (row.status !== "connected" || !installationId) return [];
    return [{ installationId, accountName: row.accountName }];
  });
}

export function isGitHubIntegrationConfigured() {
  return GITHUB_WORK_INTEGRATION_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

export function createGitHubIntegrationState(
  input: Omit<GitHubIntegrationStatePayload, "expiresAt" | "nonce">,
) {
  const payload: GitHubIntegrationStatePayload = {
    ...input,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

export function verifyGitHubIntegrationState(state: string): GitHubIntegrationStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid GitHub integration state.");
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

export function buildGitHubInstallUrl(state: string) {
  const slug = requiredEnv("GITHUB_INTEGRATION_APP_SLUG");
  const url = new URL(`https://github.com/apps/${slug}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

export function buildGitHubUserAuthorizationUrl(state: string) {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", requiredEnv("GITHUB_INTEGRATION_APP_CLIENT_ID"));
  url.searchParams.set("redirect_uri", gitHubCallbackUrl());
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
      redirect_uri: gitHubCallbackUrl(),
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
    pickItems: (page) => page.installations ?? [],
  });

  const installation = installations.find(
    (candidate) => String(candidate.id) === input.installationId,
  );
  if (!installation) {
    throw new Error("The GitHub installation was not available to the authorized user.");
  }

  return installation;
}

export async function getGitHubInstallation(input: { installationId: string }) {
  return githubRequest<GitHubInstallation>({
    token: createAppJwt(),
    authScheme: "Bearer",
    path: `/app/installations/${input.installationId}`,
    method: "GET",
  });
}

export async function listGitHubInstallationRepositories(input: {
  installationId: string;
  signal?: AbortSignal;
}) {
  const token = await getGitHubInstallationToken(input.installationId, input.signal);
  const repositories = await githubPaginatedRequest<GitHubInstallationRepositories, GitHubRepo>({
    token,
    path: "/installation/repositories",
    pickItems: (page) => page.repositories ?? [],
    ...(input.signal ? { signal: input.signal } : {}),
  });

  return repositories.map(toGitHubRepository);
}

export async function getGitHubInstallationToken(installationId: string, signal?: AbortSignal) {
  const result = await githubRequest<{ token?: string }>({
    token: createAppJwt(),
    authScheme: "Bearer",
    path: `/app/installations/${installationId}/access_tokens`,
    method: "POST",
    operation: "installation_token",
    ...(signal ? { signal } : {}),
  });

  if (!result.token) {
    throw new Error("GitHub did not return an installation token.");
  }

  return result.token;
}

export async function searchGitHubIssues(input: {
  installationId: string;
  query: string;
  limit: number;
  signal: AbortSignal;
}): Promise<unknown> {
  const token = await getGitHubInstallationToken(input.installationId, input.signal);
  const search = new URLSearchParams({ q: input.query, per_page: String(input.limit) });
  return githubRequest<unknown>({
    token,
    path: `/search/issues?${search.toString()}`,
    method: "GET",
    signal: input.signal,
  });
}

export async function syncGitHubIntegrationRepositories(input: {
  userWorkosId: string;
  workspaceId: string;
  installationId: string;
  accountLogin: string | null;
  accountType: string | null;
  repositories: GitHubRepository[];
}) {
  const db = getDb();
  const now = new Date();
  const connectionLabel = input.accountLogin?.trim() || "GitHub";
  // On reconnect (possibly by a different admin) user_workos_id stays as the
  // original connector: brain_sources rows reference it via a composite FK and
  // GitHub keeps no per-user credential, so there is nothing to re-key.
  const incompleteIntegrationUpdate = {
    connectionLabel,
    accountName: input.accountLogin,
    accountType: input.accountType,
    status: "sync_failed" as const,
    statusReason: INCOMPLETE_SYNC_STATUS_REASON,
    updatedAt: now,
  };

  const [integration] = await db
    .insert(integrations)
    .values({
      id: newIntegrationId(),
      userWorkosId: input.userWorkosId,
      workspaceId: input.workspaceId,
      provider: GITHUB_PROVIDER,
      externalId: input.installationId,
      connectionLabel,
      accountName: input.accountLogin,
      accountEmail: null,
      accountType: input.accountType,
      status: "sync_failed",
      statusReason: INCOMPLETE_SYNC_STATUS_REASON,
      scopes: [],
      lastSyncedAt: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [integrations.workspaceId, integrations.provider, integrations.externalId],
      targetWhere: sql`${integrations.workspaceId} IS NOT NULL`,
      set: incompleteIntegrationUpdate,
    })
    .returning({ id: integrations.id, userWorkosId: integrations.userWorkosId });

  if (!integration) {
    throw new Error("Could not persist Goat GitHub integration.");
  }

  const resourceValues = input.repositories.map((repository) => ({
    id: newIntegrationResourceId(),
    userWorkosId: integration.userWorkosId,
    integrationId: integration.id,
    provider: GITHUB_PROVIDER,
    resourceType: GITHUB_REPOSITORY_RESOURCE_TYPE,
    externalId: repository.githubRepoId,
    name: repository.fullName,
    displayName: repository.fullName,
    status: "available" as const,
    statusReason: null,
    lastSyncedAt: now,
    metadata: {
      defaultBranch: repository.defaultBranch,
      private: repository.private,
    },
    updatedAt: now,
  }));

  if (resourceValues.length > 0) {
    await db
      .insert(integrationResources)
      .values(resourceValues)
      .onConflictDoUpdate({
        target: [
          integrationResources.integrationId,
          integrationResources.resourceType,
          integrationResources.externalId,
        ],
        set: {
          userWorkosId: integration.userWorkosId,
          integrationId: integration.id,
          provider: GITHUB_PROVIDER,
          resourceType: GITHUB_REPOSITORY_RESOURCE_TYPE,
          name: sql`excluded.name`,
          displayName: sql`excluded.display_name`,
          status: "available",
          statusReason: null,
          lastSyncedAt: now,
          metadata: sql`excluded.metadata`,
          updatedAt: now,
        },
      });
  }

  const staleResourceUpdate = {
    status: "permission_lost" as const,
    statusReason: "Repository is no longer visible to the GitHub installation.",
    lastSyncedAt: now,
    updatedAt: now,
  };

  const staleWhere = and(
    eq(integrationResources.integrationId, integration.id),
    eq(integrationResources.userWorkosId, integration.userWorkosId),
    eq(integrationResources.provider, GITHUB_PROVIDER),
    eq(integrationResources.resourceType, GITHUB_REPOSITORY_RESOURCE_TYPE),
  );

  if (input.repositories.length > 0) {
    await db
      .update(integrationResources)
      .set(staleResourceUpdate)
      .where(
        and(
          staleWhere,
          notInArray(
            integrationResources.externalId,
            input.repositories.map((repository) => repository.githubRepoId),
          ),
        ),
      );
  } else {
    await db.update(integrationResources).set(staleResourceUpdate).where(staleWhere);
  }

  await db
    .update(integrations)
    .set({
      status: "connected",
      statusReason: null,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(integrations.workspaceId, input.workspaceId),
        eq(integrations.provider, GITHUB_PROVIDER),
        eq(integrations.id, integration.id),
      ),
    );
}

export function appendGitHubIntegrationStatus(
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  const url = new URL(sanitizeReturnTo(returnTo), getAppUrl());
  url.searchParams.set("integration", GITHUB_PROVIDER);
  url.searchParams.set("setup", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}`;
}

function gitHubCallbackUrl() {
  return `${getAppUrl()}/api/integrations/github/callback`;
}

function toGitHubRepository(repository: GitHubRepo): GitHubRepository {
  return {
    githubRepoId: String(repository.id),
    fullName: repository.full_name,
    defaultBranch: repository.default_branch?.trim() || "main",
    private: repository.private ?? true,
  };
}

async function githubRequest<T>(input: {
  token: string;
  path: string;
  method: "GET" | "POST";
  authScheme?: "Bearer" | "token";
  signal?: AbortSignal;
  operation?: "installation_token" | "request";
}): Promise<T> {
  const response = await fetch(`https://api.github.com${input.path}`, {
    method: input.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `${input.authScheme ?? "Bearer"} ${input.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (!response.ok) {
    throw new GitHubApiError(response.status, input.operation);
  }

  return (await response.json()) as T;
}

async function githubPaginatedRequest<TPage, TItem>(input: {
  token: string;
  path: string;
  authScheme?: "Bearer" | "token";
  pickItems: (page: TPage) => TItem[];
  signal?: AbortSignal;
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
      ...(input.signal ? { signal: input.signal } : {}),
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
    typeof record.userWorkosId === "string" &&
    typeof record.workspaceId === "string" &&
    typeof record.returnTo === "string" &&
    typeof record.expiresAt === "number" &&
    typeof record.nonce === "string" &&
    (record.installationId === undefined || typeof record.installationId === "string")
  );
}

function sanitizeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/settings";
  return value;
}

function signStateBody(body: string) {
  return createHmac("sha256", requiredEnv("GITHUB_INTEGRATION_STATE_SECRET"))
    .update(body)
    .digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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
  if (!value) throw new Error(`${name} is required for Goat GitHub integration.`);
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

function newIntegrationId() {
  return `gint_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function newIntegrationResourceId() {
  return `gres_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
