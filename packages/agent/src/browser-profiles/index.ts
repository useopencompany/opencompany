import { randomUUID } from "node:crypto";
import Browserbase from "@browserbasehq/sdk";
import { calculateBrowserbaseSessionCost } from "@opencompany/billing";
import { CoreError } from "@opencompany/core";
import {
  buildAad,
  DEFAULT_ENCRYPTION_KEY_VERSION,
  decryptJson,
  encryptJson,
  loadEncryptionKey,
} from "@opencompany/crypto";
import { getDb } from "@opencompany/db/client";
import { recordCreditDebit } from "@opencompany/db/credits";
import {
  type BrowserProfile,
  type BrowserProfileStatus,
  browserProfileSessions,
  browserProfiles,
  codexChatSessions,
} from "@opencompany/db/product-schema";
import { and, desc, eq, isNull } from "drizzle-orm";

// Matches the loose injection convention used by the other agent
// application services: callers may pass either the neon-http or the pooled
// node-postgres Drizzle instance.
type DbLike = any;

const COMMON_AUTH_HOSTS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "github.com",
  "auth0.com",
  "workos.com",
] as const;
const BLOCKED_HOST_SUFFIXES = [
  "amazon.com",
  "amazon.co.uk",
  "chase.com",
  "bankofamerica.com",
  "wellsfargo.com",
  "citi.com",
  "capitalone.com",
  "paypal.com",
] as const;

export type BrowserProfileView = {
  id: string;
  name: string;
  siteHost: string;
  allowedHosts: string[];
  status: BrowserProfileStatus;
  active: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConnectedBrowserProfile = {
  id: string;
  name: string;
  siteHost: string;
  allowedHosts: string[];
};

export type BrowserProfileAgentSession = {
  profile: ConnectedBrowserProfile;
  sessionId: string;
  connectUrl: string;
  liveViewPath: string;
  startedAt: Date;
};

export type BrowserbaseSessionSnapshot = {
  id: string;
  projectId: string;
  status: "PENDING" | "RUNNING" | "ERROR" | "TIMED_OUT" | "COMPLETED";
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  proxyBytes: number;
  userMetadata?: Record<string, unknown>;
};

export function browserProfilesEnabled() {
  return process.env.OPENCOMPANY_BROWSER_PROFILES_ENABLED === "true";
}

export function browserProfilesKilled() {
  return process.env.OPENCOMPANY_BROWSER_PROFILES_KILL_SWITCH === "true";
}

export function browserProfilesAvailable() {
  return browserProfilesEnabled() && !browserProfilesKilled();
}

export async function listBrowserProfilesForUser(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<BrowserProfileView[]> {
  const rows: BrowserProfile[] = await db
    .select()
    .from(browserProfiles)
    .where(eq(browserProfiles.userWorkosId, userWorkosId))
    .orderBy(desc(browserProfiles.updatedAt));
  return rows.map(toBrowserProfileView);
}

export async function listConnectedBrowserProfilesForUser(
  userWorkosId: string,
  db: DbLike = getDb(),
): Promise<ConnectedBrowserProfile[]> {
  const rows: Pick<BrowserProfile, "id" | "name" | "siteHost" | "allowedHosts">[] = await db
    .select({
      id: browserProfiles.id,
      name: browserProfiles.name,
      siteHost: browserProfiles.siteHost,
      allowedHosts: browserProfiles.allowedHosts,
    })
    .from(browserProfiles)
    .where(
      and(eq(browserProfiles.userWorkosId, userWorkosId), eq(browserProfiles.status, "connected")),
    )
    .orderBy(browserProfiles.name);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    siteHost: row.siteHost,
    allowedHosts: normalizeHostList(row.allowedHosts),
  }));
}

export async function createBrowserProfile(
  input: {
    userWorkosId: string;
    name: string;
    siteUrl: string;
  },
  db: DbLike = getDb(),
): Promise<BrowserProfileView> {
  assertBrowserProfilesAvailable();
  const name = normalizeProfileName(input.name);
  const siteHost = normalizeBrowserProfileSiteHost(input.siteUrl);
  assertAllowedProfileHost(siteHost);
  const allowedHosts = defaultAllowedBrowserProfileHosts(siteHost);
  const profileId = randomUUID();
  const context = await browserbase().contexts.create(browserbaseProjectBody());

  try {
    const encrypted = encryptBrowserbaseContextId({
      userWorkosId: input.userWorkosId,
      profileId,
      contextId: context.id,
    });
    const [row] = await db
      .insert(browserProfiles)
      .values({
        id: profileId,
        userWorkosId: input.userWorkosId,
        name,
        siteHost,
        allowedHosts,
        encryptedBrowserbaseContextId: encrypted.payload,
        encryptionKeyVersion: encrypted.keyVersion,
        status: "pending_login",
      })
      .returning();
    if (!row) throw new Error("Could not create browser profile.");
    return toBrowserProfileView(row);
  } catch (error) {
    await browserbase()
      .contexts.delete(context.id)
      .catch(() => undefined);
    throw error;
  }
}

export async function createLoginSession(
  input: { userWorkosId: string; profileId: string },
  db: DbLike = getDb(),
) {
  assertBrowserProfilesAvailable();
  const profile = await loadOwnedProfile(input.userWorkosId, input.profileId, db);
  const contextId = decryptBrowserbaseContextId(profile);
  const locked = await claimProfileSession(input.userWorkosId, input.profileId, db);
  if (!locked) {
    throw new CoreError("conflict", "This browser profile already has an active session.");
  }

  let browserbaseSessionId: string | null = null;
  try {
    const session = await browserbase().sessions.create(
      browserbaseSessionParams(profile, contextId, "login"),
    );
    browserbaseSessionId = session.id;
    const live = await browserbase().sessions.debug(session.id);
    await db
      .update(browserProfiles)
      .set({
        activeSessionId: session.id,
        lastLoginSessionId: session.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(browserProfiles.id, input.profileId),
          eq(browserProfiles.userWorkosId, input.userWorkosId),
        ),
      );
    await recordBrowserbaseSession(
      {
        userWorkosId: input.userWorkosId,
        profileId: input.profileId,
        browserbaseSessionId: session.id,
        kind: "login",
        startedAt: new Date(session.startedAt ?? Date.now()),
      },
      db,
    );
    return {
      sessionId: session.id,
      liveViewUrl: live.debuggerFullscreenUrl,
    };
  } catch (error) {
    if (browserbaseSessionId) await requestBrowserbaseSessionRelease(browserbaseSessionId);
    await releaseProfileSession(input.userWorkosId, input.profileId, undefined, db);
    throw error;
  }
}

export async function completeLoginSession(
  input: {
    userWorkosId: string;
    profileId: string;
    sessionId: string;
  },
  db: DbLike = getDb(),
) {
  assertBrowserProfilesAvailable();
  const profile = await loadOwnedProfile(input.userWorkosId, input.profileId, db);
  if (profile.activeSessionId !== input.sessionId) {
    throw new CoreError("conflict", "This login session is no longer active.");
  }
  await requestBrowserbaseSessionRelease(input.sessionId);
  const now = new Date();
  await db
    .update(browserProfiles)
    .set({
      status: "connected",
      activeSessionId: null,
      lastLoginSessionId: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(browserProfiles.id, input.profileId),
        eq(browserProfiles.userWorkosId, input.userWorkosId),
      ),
    );
  await settleBrowserbaseSession(
    {
      userWorkosId: input.userWorkosId,
      profileId: input.profileId,
      browserbaseSessionId: input.sessionId,
      fallbackEndedAt: now,
    },
    db,
  );
  return { ok: true };
}

export async function createAgentSession(
  input: {
    userWorkosId: string;
    profileId: string;
    chatSessionId: string;
    userMessageId: string | null;
  },
  db: DbLike = getDb(),
) {
  assertBrowserProfilesAvailable();
  const profile = await loadOwnedProfile(input.userWorkosId, input.profileId, db);
  if (profile.status !== "connected") {
    throw new CoreError(
      "conflict",
      "This browser profile needs to be connected before opencompany can use it.",
    );
  }
  const contextId = decryptBrowserbaseContextId(profile);
  const locked = await claimProfileSession(input.userWorkosId, input.profileId, db);
  if (!locked) {
    throw new CoreError("conflict", "This browser profile already has an active session.");
  }

  let browserbaseSessionId: string | null = null;
  try {
    const session = await browserbase().sessions.create(
      browserbaseSessionParams(profile, contextId, "agent"),
    );
    browserbaseSessionId = session.id;
    await db
      .update(browserProfiles)
      .set({
        activeSessionId: session.id,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(browserProfiles.id, input.profileId),
          eq(browserProfiles.userWorkosId, input.userWorkosId),
        ),
      );
    await recordBrowserbaseSession(
      {
        userWorkosId: input.userWorkosId,
        profileId: input.profileId,
        chatSessionId: input.chatSessionId,
        userMessageId: input.userMessageId,
        browserbaseSessionId: session.id,
        kind: "agent",
        startedAt: new Date(session.startedAt ?? Date.now()),
      },
      db,
    );
    return {
      profile: toConnectedBrowserProfile(profile),
      sessionId: session.id,
      connectUrl: session.connectUrl,
      liveViewPath: `/api/browser-profiles/${profile.id}/live-view?sessionId=${encodeURIComponent(
        session.id,
      )}`,
      startedAt: new Date(session.startedAt ?? Date.now()),
    } satisfies BrowserProfileAgentSession;
  } catch (error) {
    if (browserbaseSessionId) await requestBrowserbaseSessionRelease(browserbaseSessionId);
    await releaseProfileSession(input.userWorkosId, input.profileId, undefined, db);
    throw error;
  }
}

export async function resolveActiveAgentSession(
  input: {
    userWorkosId: string;
    chatSessionId: string;
  },
  db: DbLike = getDb(),
): Promise<BrowserProfileAgentSession | null> {
  if (!browserProfilesAvailable()) return null;
  const [row] = await db
    .select({
      profileId: browserProfiles.id,
      profileName: browserProfiles.name,
      siteHost: browserProfiles.siteHost,
      allowedHosts: browserProfiles.allowedHosts,
      browserbaseSessionId: browserProfileSessions.browserbaseSessionId,
      startedAt: browserProfileSessions.startedAt,
    })
    .from(browserProfileSessions)
    .innerJoin(
      browserProfiles,
      and(
        eq(browserProfiles.id, browserProfileSessions.profileId),
        eq(browserProfiles.activeSessionId, browserProfileSessions.browserbaseSessionId),
      ),
    )
    .where(
      and(
        eq(browserProfileSessions.userWorkosId, input.userWorkosId),
        eq(browserProfiles.userWorkosId, input.userWorkosId),
        eq(browserProfiles.status, "connected"),
        eq(browserProfileSessions.chatSessionId, input.chatSessionId),
        eq(browserProfileSessions.kind, "agent"),
        isNull(browserProfileSessions.endedAt),
      ),
    )
    .orderBy(desc(browserProfileSessions.createdAt))
    .limit(1);
  if (!row) return null;
  let session: { connectUrl?: string };
  try {
    session = await browserbase().sessions.retrieve(row.browserbaseSessionId);
  } catch {
    await endAgentSession(
      {
        userWorkosId: input.userWorkosId,
        profileId: row.profileId,
        sessionId: row.browserbaseSessionId,
      },
      db,
    );
    throw new Error("The authenticated browser session is no longer available.");
  }
  if (!session.connectUrl) {
    await endAgentSession(
      {
        userWorkosId: input.userWorkosId,
        profileId: row.profileId,
        sessionId: row.browserbaseSessionId,
      },
      db,
    );
    throw new Error("The authenticated browser session is no longer connectable.");
  }
  return {
    profile: {
      id: row.profileId,
      name: row.profileName,
      siteHost: row.siteHost,
      allowedHosts: normalizeHostList(row.allowedHosts),
    },
    sessionId: row.browserbaseSessionId,
    connectUrl: session.connectUrl,
    liveViewPath: `/api/browser-profiles/${row.profileId}/live-view?sessionId=${encodeURIComponent(
      row.browserbaseSessionId,
    )}`,
    startedAt: row.startedAt ?? new Date(),
  } satisfies BrowserProfileAgentSession;
}

export async function endAgentSession(
  input: {
    userWorkosId: string;
    profileId: string;
    sessionId: string;
  },
  db: DbLike = getDb(),
) {
  const now = new Date();
  await requestBrowserbaseSessionRelease(input.sessionId);
  await releaseProfileSession(input.userWorkosId, input.profileId, input.sessionId, db);
  await settleBrowserbaseSession(
    {
      userWorkosId: input.userWorkosId,
      profileId: input.profileId,
      browserbaseSessionId: input.sessionId,
      fallbackEndedAt: now,
    },
    db,
  );
}

export async function deleteBrowserProfile(
  input: { userWorkosId: string; profileId: string },
  db: DbLike = getDb(),
) {
  assertBrowserProfilesAvailable();
  const profile = await loadOwnedProfile(input.userWorkosId, input.profileId, db);
  if (profile.activeSessionId) {
    await requestBrowserbaseSessionRelease(profile.activeSessionId);
  }
  const contextId = decryptBrowserbaseContextId(profile);
  await browserbase()
    .contexts.delete(contextId)
    .catch(() => undefined);
  await db
    .delete(browserProfiles)
    .where(
      and(
        eq(browserProfiles.id, input.profileId),
        eq(browserProfiles.userWorkosId, input.userWorkosId),
      ),
    );
  return { ok: true };
}

export async function resolveLiveViewUrl(
  input: {
    userWorkosId: string;
    profileId: string;
    sessionId: string;
  },
  db: DbLike = getDb(),
) {
  const profile = await loadOwnedProfile(input.userWorkosId, input.profileId, db);
  if (
    profile.activeSessionId !== input.sessionId &&
    profile.lastLoginSessionId !== input.sessionId
  ) {
    throw new CoreError("not_found", "This browser session is not active.");
  }
  const live = await browserbase().sessions.debug(input.sessionId);
  return live.debuggerFullscreenUrl;
}

function browserbase() {
  const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
  if (!apiKey) throw new Error("BROWSERBASE_API_KEY is required.");
  return new Browserbase({ apiKey });
}

function browserbaseProjectBody() {
  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
  return projectId ? { projectId } : {};
}

function browserbaseSessionParams(
  profile: Pick<BrowserProfile, "id" | "siteHost" | "allowedHosts">,
  contextId: string,
  kind: "login" | "agent",
) {
  const allowedDomains =
    kind === "login"
      ? loginAllowedBrowserProfileHosts(profile.allowedHosts)
      : normalizeHostList(profile.allowedHosts);
  return {
    ...browserbaseProjectBody(),
    keepAlive: true,
    proxies: true,
    browserSettings: {
      context: { id: contextId, persist: true },
      allowedDomains,
      verified: true,
      recordSession: true,
    },
    userMetadata: {
      surface: "goat-browser-profile",
      kind,
      profileId: profile.id,
      siteHost: profile.siteHost,
    },
  };
}

function encryptBrowserbaseContextId(input: {
  userWorkosId: string;
  profileId: string;
  contextId: string;
}) {
  const keyVersion = DEFAULT_ENCRYPTION_KEY_VERSION;
  return {
    keyVersion,
    payload: encryptJson(
      { browserbaseContextId: input.contextId },
      {
        key: loadEncryptionKey(keyVersion),
        aad: browserProfileAad(input.userWorkosId, input.profileId),
      },
    ),
  };
}

function decryptBrowserbaseContextId(
  profile: Pick<
    BrowserProfile,
    "id" | "userWorkosId" | "encryptedBrowserbaseContextId" | "encryptionKeyVersion"
  >,
) {
  const payload = decryptJson(profile.encryptedBrowserbaseContextId, {
    key: loadEncryptionKey(profile.encryptionKeyVersion),
    aad: browserProfileAad(profile.userWorkosId, profile.id),
  });
  const value = payload.browserbaseContextId;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Browser profile credential is invalid.");
  }
  return value;
}

function browserProfileAad(userWorkosId: string, profileId: string) {
  return buildAad({ userWorkosId, profileId });
}

async function loadOwnedProfile(
  userWorkosId: string,
  profileId: string,
  db: DbLike,
): Promise<BrowserProfile> {
  const [profile] = await db
    .select()
    .from(browserProfiles)
    .where(and(eq(browserProfiles.id, profileId), eq(browserProfiles.userWorkosId, userWorkosId)))
    .limit(1);
  if (!profile) throw new CoreError("not_found", "Browser profile not found.");
  return profile;
}

async function claimProfileSession(userWorkosId: string, profileId: string, db: DbLike) {
  const [row] = await db
    .update(browserProfiles)
    .set({ activeSessionId: "starting", updatedAt: new Date() })
    .where(
      and(
        eq(browserProfiles.id, profileId),
        eq(browserProfiles.userWorkosId, userWorkosId),
        isNull(browserProfiles.activeSessionId),
      ),
    )
    .returning({ id: browserProfiles.id });
  return Boolean(row);
}

async function releaseProfileSession(
  userWorkosId: string,
  profileId: string,
  sessionId: string | undefined,
  db: DbLike,
) {
  await db
    .update(browserProfiles)
    .set({ activeSessionId: null, updatedAt: new Date() })
    .where(
      and(
        eq(browserProfiles.id, profileId),
        eq(browserProfiles.userWorkosId, userWorkosId),
        sessionId ? eq(browserProfiles.activeSessionId, sessionId) : undefined,
      ),
    );
}

export async function requestBrowserbaseSessionRelease(sessionId: string) {
  try {
    await browserbase().sessions.update(sessionId, {
      ...browserbaseProjectBody(),
      status: "REQUEST_RELEASE",
    });
    return true;
  } catch {
    return false;
  }
}

export async function listRunningBrowserbaseProfileSessions(): Promise<
  BrowserbaseSessionSnapshot[]
> {
  const sessions = await browserbase().sessions.list({
    status: "RUNNING",
    q: "user_metadata['surface']:'goat-browser-profile'",
  });
  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
  return projectId ? sessions.filter((session) => session.projectId === projectId) : sessions;
}

export async function retrieveBrowserbaseSession(
  sessionId: string,
): Promise<BrowserbaseSessionSnapshot> {
  return browserbase().sessions.retrieve(sessionId);
}

async function recordBrowserbaseSession(
  input: {
    userWorkosId: string;
    profileId: string;
    chatSessionId?: string;
    userMessageId?: string | null;
    browserbaseSessionId: string;
    kind: "login" | "agent";
    startedAt: Date;
  },
  db: DbLike,
) {
  await db.insert(browserProfileSessions).values({
    userWorkosId: input.userWorkosId,
    profileId: input.profileId,
    chatSessionId: input.chatSessionId,
    userMessageId: input.userMessageId,
    browserbaseSessionId: input.browserbaseSessionId,
    kind: input.kind,
    startedAt: input.startedAt,
    costBasis: { provider: "browserbase", status: "unpriced" },
  });
}

export async function settleBrowserbaseSession(
  input: {
    userWorkosId: string;
    profileId: string;
    browserbaseSessionId: string;
    fallbackEndedAt?: Date;
    snapshot?: BrowserbaseSessionSnapshot;
  },
  db: DbLike,
) {
  const [row] = await db
    .select({
      id: browserProfileSessions.id,
      chatSessionId: browserProfileSessions.chatSessionId,
      kind: browserProfileSessions.kind,
      startedAt: browserProfileSessions.startedAt,
      endedAt: browserProfileSessions.endedAt,
      costBasis: browserProfileSessions.costBasis,
    })
    .from(browserProfileSessions)
    .where(
      and(
        eq(browserProfileSessions.userWorkosId, input.userWorkosId),
        eq(browserProfileSessions.profileId, input.profileId),
        eq(browserProfileSessions.browserbaseSessionId, input.browserbaseSessionId),
      ),
    )
    .limit(1);
  if (!row) return false;
  if (row.endedAt && row.costBasis.status === "priced") return true;

  let snapshot = input.snapshot;
  if (!snapshot) {
    try {
      snapshot = await retrieveBrowserbaseSession(input.browserbaseSessionId);
    } catch {
      return false;
    }
  }
  if (snapshot.status === "PENDING" || snapshot.status === "RUNNING") return false;

  await releaseProfileSession(input.userWorkosId, input.profileId, input.browserbaseSessionId, db);

  const startedAt = validProviderDate(snapshot.startedAt) ?? row.startedAt;
  const endedAt =
    validProviderDate(snapshot.endedAt) ??
    validProviderDate(snapshot.updatedAt) ??
    input.fallbackEndedAt ??
    validProviderDate(snapshot.startedAt);
  if (!startedAt || !endedAt) return false;
  const durationMs = Math.max(0, endedAt.getTime() - startedAt.getTime());
  const cost = calculateBrowserbaseSessionCost({
    durationMs,
    proxyBytes: snapshot.proxyBytes,
  });
  const rawMetrics = {
    provider: "browserbase",
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
    endedAt: snapshot.endedAt ?? endedAt.toISOString(),
    proxyBytes: snapshot.proxyBytes,
  };
  let ledgerStatus: "recorded" | "not_billable" | "unattributed" = cost.billable
    ? "unattributed"
    : "not_billable";

  if (cost.billable && row.chatSessionId) {
    const [owner] = await db
      .select({ workspaceId: codexChatSessions.workspaceId })
      .from(codexChatSessions)
      .where(
        and(
          eq(codexChatSessions.chatSessionId, row.chatSessionId),
          eq(codexChatSessions.userWorkosId, input.userWorkosId),
        ),
      )
      .limit(1);
    if (!owner?.workspaceId) {
      await markBrowserbaseSettlementPending(
        row.id,
        rawMetrics,
        { ...cost.costBasis, status: "pricing_pending", reason: "workspace_unresolved" },
        db,
      );
      return false;
    }
    try {
      await recordCreditDebit({
        workspaceId: owner.workspaceId,
        userWorkosId: input.userWorkosId,
        source: "sandbox_usage",
        idempotencyKey: `browserbase-session:${input.browserbaseSessionId}`,
        chatSessionId: row.chatSessionId,
        providerCostUsdMicros: cost.providerCostUsdMicros,
        platformFeeUsdMicros: cost.platformFeeUsdMicros,
        totalCostUsdMicros: cost.totalCostUsdMicros,
        costBasis: cost.costBasis,
        metadata: {
          provider: "browserbase",
          browserProfileSessionId: row.id,
          kind: row.kind,
        },
        db,
      });
      ledgerStatus = "recorded";
    } catch {
      await markBrowserbaseSettlementPending(
        row.id,
        rawMetrics,
        { ...cost.costBasis, status: "pricing_pending", reason: "ledger_write_failed" },
        db,
      );
      return false;
    }
  }

  await db
    .update(browserProfileSessions)
    .set({
      startedAt,
      endedAt,
      durationMs,
      providerCostUsdMicros: cost.providerCostUsdMicros,
      platformFeeUsdMicros: cost.platformFeeUsdMicros,
      totalCostUsdMicros: cost.totalCostUsdMicros,
      rawMetrics,
      costBasis: { ...cost.costBasis, status: "priced", ledgerStatus },
    })
    .where(eq(browserProfileSessions.id, row.id));
  return true;
}

async function markBrowserbaseSettlementPending(
  id: number,
  rawMetrics: Record<string, unknown>,
  costBasis: Record<string, unknown>,
  db: DbLike,
) {
  await db
    .update(browserProfileSessions)
    .set({ rawMetrics, costBasis })
    .where(eq(browserProfileSessions.id, id));
}

function validProviderDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function toBrowserProfileView(row: BrowserProfile): BrowserProfileView {
  return {
    id: row.id,
    name: row.name,
    siteHost: row.siteHost,
    allowedHosts: normalizeHostList(row.allowedHosts),
    status: row.status,
    active: Boolean(row.activeSessionId),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toConnectedBrowserProfile(
  row: Pick<BrowserProfile, "id" | "name" | "siteHost" | "allowedHosts">,
): ConnectedBrowserProfile {
  return {
    id: row.id,
    name: row.name,
    siteHost: row.siteHost,
    allowedHosts: normalizeHostList(row.allowedHosts),
  };
}

function normalizeProfileName(value: string) {
  const name = value.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) throw new CoreError("invalid_argument", "Profile name is required.");
  return name;
}

export function normalizeBrowserProfileSiteHost(value: string) {
  const raw = value.trim();
  if (!raw) throw new CoreError("invalid_argument", "Site URL is required.");
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new CoreError("invalid_argument", "Site URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CoreError("invalid_argument", "Site URL must use http or https.");
  }
  return registrableHost(url.hostname);
}

function registrableHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  const lastThree = parts.slice(-3).join(".");
  if (
    ["co.uk", "com.au", "co.jp", "com.br", "com.mx", "co.in", "co.nz"].includes(lastTwo) &&
    parts.length >= 3
  ) {
    return lastThree;
  }
  return lastTwo;
}

function normalizeHostList(hosts: readonly string[]) {
  return [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))];
}

export function defaultAllowedBrowserProfileHosts(siteHost: string) {
  return normalizeHostList([siteHost]);
}

export function loginAllowedBrowserProfileHosts(profileHosts: readonly string[]) {
  return normalizeHostList([...profileHosts, ...COMMON_AUTH_HOSTS]);
}

export function isBrowserProfileHostBlocked(siteHost: string) {
  return BLOCKED_HOST_SUFFIXES.some(
    (blocked) => siteHost === blocked || siteHost.endsWith(`.${blocked}`),
  );
}

function assertAllowedProfileHost(siteHost: string) {
  if (isBrowserProfileHostBlocked(siteHost)) {
    throw new CoreError(
      "invalid_argument",
      "opencompany cannot connect browser profiles for this site.",
    );
  }
}

function assertBrowserProfilesAvailable() {
  if (!browserProfilesEnabled()) {
    throw new CoreError("unavailable", "Browser profiles are not enabled.");
  }
  if (browserProfilesKilled()) {
    throw new CoreError("unavailable", "Browser profiles are temporarily disabled.");
  }
}
