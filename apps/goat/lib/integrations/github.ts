import { createHmac, createSign, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { goatIntegrationResources, goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { getGoatAppUrl } from "@/lib/workos";

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

export type GoatGitHubRepository = {
  githubRepoId: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
};

export type GoatGitHubConnectedInstallation = {
  installationId: string;
  accountName: string | null;
};

export class GoatGitHubApiError extends Error {
  readonly status: number;
  readonly operation: "installation_token" | "request";

  constructor(status: number, operation: "installation_token" | "request" = "request") {
    super(`GitHub API request failed with ${status}.`);
    this.name = "GoatGitHubApiError";
    this.status = status;
    this.operation = operation;
  }
}

export type GoatGitHubProviderState = {
  provider: "github";
  connected: boolean;
  status: "connected" | "needs_reauth" | "sync_failed" | "disconnected" | "not_connected";
  integrationId: string | null;
  accountName: string | null;
  statusReason: string | null;
};

export type GoatGitHubIntegrationStatePayload = {
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

export async function getGoatGitHubIntegrationState(
  workspaceId: string,
): Promise<GoatGitHubProviderState> {
  const [row] = await getDb()
    .select({
      id: goatIntegrations.id,
      status: goatIntegrations.status,
      accountName: goatIntegrations.accountName,
      statusReason: goatIntegrations.statusReason,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.workspaceId, workspaceId),
        eq(goatIntegrations.provider, GITHUB_PROVIDER),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
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

export async function listConnectedGoatGitHubInstallations(
  workspaceId: string,
): Promise<GoatGitHubConnectedInstallation[]> {
  const rows = await getDb()
    .select({
      installationId: goatIntegrations.externalId,
      accountName: goatIntegrations.accountName,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(
      and(
        eq(goatIntegrations.workspaceId, workspaceId),
        eq(goatIntegrations.provider, GITHUB_PROVIDER),
      ),
    )
    .orderBy(desc(goatIntegrations.updatedAt));

  return rows.flatMap((row) => {
    const installationId = row.installationId?.trim();
    if (row.status !== "connected" || !installationId) return [];
    return [{ installationId, accountName: row.accountName }];
  });
}

export function isGoatGitHubIntegrationConfigured() {
  return GITHUB_WORK_INTEGRATION_ENVS.every((name) => Boolean(process.env[name]?.trim()));
}

export function createGoatGitHubIntegrationState(
  input: Omit<GoatGitHubIntegrationStatePayload, "expiresAt" | "nonce">,
) {
  const payload: GoatGitHubIntegrationStatePayload = {
    ...input,
    returnTo: sanitizeReturnTo(input.returnTo),
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signStateBody(body)}`;
}

export function verifyGoatGitHubIntegrationState(state: string): GoatGitHubIntegrationStatePayload {
  const [body, signature] = state.split(".");
  if (!body || !signature || !safeEqual(signature, signStateBody(body))) {
    throw new Error("Invalid GitHub integration state.");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  if (!isGoatGitHubIntegrationStatePayload(payload)) {
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

export function buildGoatGitHubInstallUrl(state: string) {
  const slug = requiredEnv("GITHUB_INTEGRATION_APP_SLUG");
  const url = new URL(`https://github.com/apps/${slug}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

export function buildGoatGitHubUserAuthorizationUrl(state: string) {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", requiredEnv("GITHUB_INTEGRATION_APP_CLIENT_ID"));
  url.searchParams.set("redirect_uri", goatGitHubCallbackUrl());
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGoatGitHubUserCode(code: string) {
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
      redirect_uri: goatGitHubCallbackUrl(),
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

export async function verifyGoatGitHubUserInstallation(input: {
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

export async function getGoatGitHubInstallation(input: { installationId: string }) {
  return githubRequest<GitHubInstallation>({
    token: createAppJwt(),
    authScheme: "Bearer",
    path: `/app/installations/${input.installationId}`,
    method: "GET",
  });
}

export async function listGoatGitHubInstallationRepositories(input: {
  installationId: string;
  signal?: AbortSignal;
}) {
  const token = await getGoatGitHubInstallationToken(input.installationId, input.signal);
  const repositories = await githubPaginatedRequest<GitHubInstallationRepositories, GitHubRepo>({
    token,
    path: "/installation/repositories",
    pickItems: (page) => page.repositories ?? [],
    ...(input.signal ? { signal: input.signal } : {}),
  });

  return repositories.map(toGoatGitHubRepository);
}

export async function getGoatGitHubInstallationToken(installationId: string, signal?: AbortSignal) {
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

export async function searchGoatGitHubIssues(input: {
  installationId: string;
  query: string;
  limit: number;
  signal: AbortSignal;
}): Promise<unknown> {
  const token = await getGoatGitHubInstallationToken(input.installationId, input.signal);
  const search = new URLSearchParams({ q: input.query, per_page: String(input.limit) });
  return githubRequest<unknown>({
    token,
    path: `/search/issues?${search.toString()}`,
    method: "GET",
    signal: input.signal,
  });
}

export async function syncGoatGitHubIntegrationRepositories(input: {
  userWorkosId: string;
  workspaceId: string;
  installationId: string;
  accountLogin: string | null;
  accountType: string | null;
  repositories: GoatGitHubRepository[];
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
    .insert(goatIntegrations)
    .values({
      id: newGoatIntegrationId(),
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
      target: [
        goatIntegrations.workspaceId,
        goatIntegrations.provider,
        goatIntegrations.externalId,
      ],
      targetWhere: sql`${goatIntegrations.workspaceId} IS NOT NULL`,
      set: incompleteIntegrationUpdate,
    })
    .returning({ id: goatIntegrations.id, userWorkosId: goatIntegrations.userWorkosId });

  if (!integration) {
    throw new Error("Could not persist Goat GitHub integration.");
  }

  const resourceValues = input.repositories.map((repository) => ({
    id: newGoatIntegrationResourceId(),
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
      .insert(goatIntegrationResources)
      .values(resourceValues)
      .onConflictDoUpdate({
        target: [
          goatIntegrationResources.integrationId,
          goatIntegrationResources.resourceType,
          goatIntegrationResources.externalId,
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
    eq(goatIntegrationResources.integrationId, integration.id),
    eq(goatIntegrationResources.userWorkosId, integration.userWorkosId),
    eq(goatIntegrationResources.provider, GITHUB_PROVIDER),
    eq(goatIntegrationResources.resourceType, GITHUB_REPOSITORY_RESOURCE_TYPE),
  );

  if (input.repositories.length > 0) {
    await db
      .update(goatIntegrationResources)
      .set(staleResourceUpdate)
      .where(
        and(
          staleWhere,
          notInArray(
            goatIntegrationResources.externalId,
            input.repositories.map((repository) => repository.githubRepoId),
          ),
        ),
      );
  } else {
    await db.update(goatIntegrationResources).set(staleResourceUpdate).where(staleWhere);
  }

  await db
    .update(goatIntegrations)
    .set({
      status: "connected",
      statusReason: null,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(goatIntegrations.workspaceId, input.workspaceId),
        eq(goatIntegrations.provider, GITHUB_PROVIDER),
        eq(goatIntegrations.id, integration.id),
      ),
    );
}

export function appendGoatGitHubIntegrationStatus(
  returnTo: string,
  status: "connected" | "error",
  reason?: string,
) {
  const url = new URL(sanitizeReturnTo(returnTo), getGoatAppUrl());
  url.searchParams.set("integration", GITHUB_PROVIDER);
  url.searchParams.set("setup", status);
  if (status === "error" && reason) url.searchParams.set("reason", reason);
  return `${url.pathname}${url.search}`;
}

function goatGitHubCallbackUrl() {
  return `${getGoatAppUrl()}/api/integrations/github/callback`;
}

function toGoatGitHubRepository(repository: GitHubRepo): GoatGitHubRepository {
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
    throw new GoatGitHubApiError(response.status, input.operation);
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

function isGoatGitHubIntegrationStatePayload(
  value: unknown,
): value is GoatGitHubIntegrationStatePayload {
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

function newGoatIntegrationId() {
  return `gint_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function newGoatIntegrationResourceId() {
  return `gres_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
