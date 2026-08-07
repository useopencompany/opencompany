import { randomUUID } from "node:crypto";
import Browserbase from "@browserbasehq/sdk";
import {
  buildAad,
  DEFAULT_ENCRYPTION_KEY_VERSION,
  decryptJson,
  encryptJson,
  loadEncryptionKey,
} from "@opencompany/crypto";
import { getDb } from "@opencompany/db/client";
import {
  type BrowserProfile,
  type BrowserProfileStatus,
  browserProfileSessions,
  browserProfiles,
} from "@opencompany/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";

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

export function browserProfilesEnabled() {
  return process.env.GOAT_BROWSER_PROFILES_ENABLED === "true";
}

export function browserProfilesKilled() {
  return process.env.GOAT_BROWSER_PROFILES_KILL_SWITCH === "true";
}

export function browserProfilesAvailable() {
  return browserProfilesEnabled() && !browserProfilesKilled();
}

export async function listBrowserProfilesForUser(userWorkosId: string) {
  const rows = await getDb()
    .select()
    .from(browserProfiles)
    .where(eq(browserProfiles.userWorkosId, userWorkosId))
    .orderBy(desc(browserProfiles.updatedAt));
  return rows.map(toBrowserProfileView);
}

export async function listConnectedBrowserProfilesForUser(userWorkosId: string) {
  const rows = await getDb()
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

export async function createBrowserProfile(input: {
  userWorkosId: string;
  name: string;
  siteUrl: string;
}) {
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
    const [row] = await getDb()
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

export async function createLoginSession(input: { userWorkosId: string; profileId: string }) {
  assertBrowserProfilesAvailable();
  const profile = await loadOwnedProfile(input.userWorkosId, input.profileId);
  const contextId = decryptBrowserbaseContextId(profile);
  const locked = await claimProfileSession(input.userWorkosId, input.profileId);
  if (!locked) throw new Error("This browser profile already has an active session.");

  let browserbaseSessionId: string | null = null;
  try {
    const session = await browserbase().sessions.create(
      browserbaseSessionParams(profile, contextId, "login"),
    );
    browserbaseSessionId = session.id;
    const live = await browserbase().sessions.debug(session.id);
    await getDb()
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
    await recordBrowserbaseSession({
      userWorkosId: input.userWorkosId,
      profileId: input.profileId,
      browserbaseSessionId: session.id,
      kind: "login",
      startedAt: new Date(session.startedAt ?? Date.now()),
    });
    return {
      sessionId: session.id,
      liveViewUrl: live.debuggerFullscreenUrl,
    };
  } catch (error) {
    if (browserbaseSessionId) await requestSessionRelease(browserbaseSessionId);
    await releaseProfileSession(input.userWorkosId, input.profileId);
    throw error;
  }
}

export async function completeLoginSession(input: {
  userWorkosId: string;
  profileId: string;
  sessionId: string;
}) {
  assertBrowserProfilesAvailable();
  const profile = await loadOwnedProfile(input.userWorkosId, input.profileId);
  if (profile.activeSessionId !== input.sessionId) {
    throw new Error("This login session is no longer active.");
  }
  await requestSessionRelease(input.sessionId);
  const now = new Date();
  await getDb()
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
  await finishBrowserbaseSession({
    userWorkosId: input.userWorkosId,
    profileId: input.profileId,
    browserbaseSessionId: input.sessionId,
    endedAt: now,
  });
  return { ok: true };
}

export async function createAgentSession(input: {
  userWorkosId: string;
  profileId: string;
  chatSessionId: string;
  userMessageId: string | null;
}) {
  assertBrowserProfilesAvailable();
  const profile = await loadOwnedProfile(input.userWorkosId, input.profileId);
  if (profile.status !== "connected") {
    throw new Error("This browser profile needs to be connected before Goat can use it.");
  }
  const contextId = decryptBrowserbaseContextId(profile);
  const locked = await claimProfileSession(input.userWorkosId, input.profileId);
  if (!locked) throw new Error("This browser profile already has an active session.");

  let browserbaseSessionId: string | null = null;
  try {
    const session = await browserbase().sessions.create(
      browserbaseSessionParams(profile, contextId, "agent"),
    );
    browserbaseSessionId = session.id;
    await getDb()
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
    await recordBrowserbaseSession({
      userWorkosId: input.userWorkosId,
      profileId: input.profileId,
      chatSessionId: input.chatSessionId,
      userMessageId: input.userMessageId,
      browserbaseSessionId: session.id,
      kind: "agent",
      startedAt: new Date(session.startedAt ?? Date.now()),
    });
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
    if (browserbaseSessionId) await requestSessionRelease(browserbaseSessionId);
    await releaseProfileSession(input.userWorkosId, input.profileId);
    throw error;
  }
}

export async function endAgentSession(input: {
  userWorkosId: string;
  profileId: string;
  sessionId: string;
}) {
  const now = new Date();
  await requestSessionRelease(input.sessionId);
  await releaseProfileSession(input.userWorkosId, input.profileId, input.sessionId);
  await finishBrowserbaseSession({
    userWorkosId: input.userWorkosId,
    profileId: input.profileId,
    browserbaseSessionId: input.sessionId,
    endedAt: now,
  });
}

export async function deleteBrowserProfile(input: { userWorkosId: string; profileId: string }) {
  assertBrowserProfilesAvailable();
  const profile = await loadOwnedProfile(input.userWorkosId, input.profileId);
  if (profile.activeSessionId) {
    await requestSessionRelease(profile.activeSessionId);
  }
  const contextId = decryptBrowserbaseContextId(profile);
  await browserbase()
    .contexts.delete(contextId)
    .catch(() => undefined);
  await getDb()
    .delete(browserProfiles)
    .where(
      and(
        eq(browserProfiles.id, input.profileId),
        eq(browserProfiles.userWorkosId, input.userWorkosId),
      ),
    );
  return { ok: true };
}

export async function resolveLiveViewUrl(input: {
  userWorkosId: string;
  profileId: string;
  sessionId: string;
}) {
  const profile = await loadOwnedProfile(input.userWorkosId, input.profileId);
  if (
    profile.activeSessionId !== input.sessionId &&
    profile.lastLoginSessionId !== input.sessionId
  ) {
    throw new Error("This browser session is not active.");
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

async function loadOwnedProfile(userWorkosId: string, profileId: string) {
  const [profile] = await getDb()
    .select()
    .from(browserProfiles)
    .where(and(eq(browserProfiles.id, profileId), eq(browserProfiles.userWorkosId, userWorkosId)))
    .limit(1);
  if (!profile) throw new Error("Browser profile not found.");
  return profile;
}

async function claimProfileSession(userWorkosId: string, profileId: string) {
  const [row] = await getDb()
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

async function releaseProfileSession(userWorkosId: string, profileId: string, sessionId?: string) {
  await getDb()
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

async function requestSessionRelease(sessionId: string) {
  await browserbase()
    .sessions.update(sessionId, {
      ...browserbaseProjectBody(),
      status: "REQUEST_RELEASE",
    })
    .catch(() => undefined);
}

async function recordBrowserbaseSession(input: {
  userWorkosId: string;
  profileId: string;
  chatSessionId?: string;
  userMessageId?: string | null;
  browserbaseSessionId: string;
  kind: "login" | "agent";
  startedAt: Date;
}) {
  await getDb()
    .insert(browserProfileSessions)
    .values({
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

async function finishBrowserbaseSession(input: {
  userWorkosId: string;
  profileId: string;
  browserbaseSessionId: string;
  endedAt: Date;
}) {
  const [row] = await getDb()
    .select({ startedAt: browserProfileSessions.startedAt })
    .from(browserProfileSessions)
    .where(
      and(
        eq(browserProfileSessions.userWorkosId, input.userWorkosId),
        eq(browserProfileSessions.profileId, input.profileId),
        eq(browserProfileSessions.browserbaseSessionId, input.browserbaseSessionId),
      ),
    )
    .limit(1);
  const durationMs = row?.startedAt
    ? Math.max(0, input.endedAt.getTime() - row.startedAt.getTime())
    : 0;
  await getDb()
    .update(browserProfileSessions)
    .set({ endedAt: input.endedAt, durationMs })
    .where(
      and(
        eq(browserProfileSessions.userWorkosId, input.userWorkosId),
        eq(browserProfileSessions.profileId, input.profileId),
        eq(browserProfileSessions.browserbaseSessionId, input.browserbaseSessionId),
      ),
    );
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
  if (!name) throw new Error("Profile name is required.");
  return name;
}

export function normalizeBrowserProfileSiteHost(value: string) {
  const raw = value.trim();
  if (!raw) throw new Error("Site URL is required.");
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Site URL must use http or https.");
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
    throw new Error("Goat cannot connect browser profiles for this site.");
  }
}

function assertBrowserProfilesAvailable() {
  if (!browserProfilesEnabled()) throw new Error("Browser profiles are not enabled.");
  if (browserProfilesKilled()) throw new Error("Browser profiles are temporarily disabled.");
}
