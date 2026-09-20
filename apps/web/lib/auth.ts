import type { IdentityDto } from "@opencompany/protocol";
import { saveSession, withAuth } from "@workos-inc/authkit-nextjs";
import type { AuthenticationResponse, User as WorkOSUser } from "@workos-inc/node";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { cache } from "react";
import { recordLastAuthMethod } from "@/lib/auth-methods";
import { serverApiClient, serverApiError } from "@/lib/server-api-client";
import { ACTIVE_WORKSPACE_COOKIE, rememberActiveWorkspace } from "@/lib/workspace-session";

export { ACTIVE_WORKSPACE_COOKIE };

export type IdentityUser = {
  workosUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  timezone: string;
  botsEnabled?: boolean;
  autoModelRoutingEnabled: boolean;
  approveForMeEnabled: boolean;
  chatCapabilitiesBetaEnabled: boolean;
  reviewInboxEnabled: boolean;
  sidebarProjectsEnabled: boolean;
  subagentsEnabled: boolean;
  companyAgentsEnabled: boolean;
  pastSessionAccessEnabled: boolean;
  imessageEnabled: boolean;
  whatsappEnabled: boolean;
  /** @deprecated Wiki is always enabled. */
  wikiEnabled: true;
  taskViewMode: "board" | "list";
  taskTimeRange: "24h" | "2d" | "7d" | "30d" | "90d" | "all";
  preferredMcpClient: "claude" | "chatgpt" | "cursor" | null;
  mcpSetupCompletedAt: Date | null;
  onboardedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type IdentityWorkspace = {
  id: string;
  name: string;
  slug: string | null;
};

export type WorkspaceWithRole = {
  workspace: IdentityWorkspace;
  role: "admin" | "member";
};

export type IdentityContext = {
  authUser: WorkOSUser;
  organizationId: string | null;
  user: IdentityUser;
  workspaces: WorkspaceWithRole[];
};

export type AuthContext = {
  authUser: WorkOSUser;
  organizationId: string | null;
  user: IdentityUser;
  workspace: IdentityWorkspace;
  role: "admin" | "member";
  workspaces: WorkspaceWithRole[];
};

// Shared by both custom sign-in surfaces. WorkOS session sealing and browser
// preference cookies remain in Next.js; all identity persistence and membership
// adoption run through the authenticated API identity tier.
export async function completeAuthentication(
  authResponse: AuthenticationResponse,
  request: NextRequest | string,
) {
  await saveSession(authResponse, request);
  await recordLastAuthMethod(authResponse.authenticationMethod);
  // saveSession updates Next.js's mutable cookie store; the incoming Cookie
  // header still contains the pre-authentication session (or no session).
  const sessionCookieName = process.env.WORKOS_COOKIE_NAME?.trim() || "wos-session";
  const sessionCookie = (await cookies()).get(sessionCookieName);
  if (!sessionCookie) {
    throw new Error("Could not read the newly saved authentication session.");
  }
  const requestUrl = typeof request === "string" ? request : request.url;
  const client = await serverApiClient({
    sessionCookie,
    origin: new URL(requestUrl).origin,
  });
  const response = await client.v1.identity.sync.$post();
  if (!response.ok) {
    throw await serverApiError(response, "Could not synchronize the authenticated identity.");
  }
  const { data } = await response.json();
  if (authResponse.organizationId && data.activeWorkspaceId) {
    try {
      await rememberActiveWorkspace({
        workspaceId: data.activeWorkspaceId,
      });
    } catch (error) {
      console.error("[opencompany] Failed to activate the authenticated workspace", error);
    }
  }
}

// React cache() preserves the request-local semantics relied on by the RSC and
// route callers: every consumer shares one AuthKit read and one API identity read.
const resolveSession = cache(
  async (): Promise<{
    authUser: WorkOSUser;
    organizationId: string | null;
    data: IdentityDto;
  } | null> => {
    const session = await withAuth();
    if (!session.user) return null;
    const response = await (await serverApiClient()).v1.identity.$get();
    // AuthKit can still decode a browser session while the canonical API has already
    // rejected it during expiry or refresh. Treat that race as signed out so the
    // existing page boundary sends the browser through the normal sign-in flow.
    if (response.status === 401) return null;
    if (!response.ok) throw await serverApiError(response, "Could not load your workspace.");
    const data = (await response.json()).data as IdentityDto;
    return {
      authUser: session.user,
      organizationId: session.organizationId ?? null,
      data,
    };
  },
);

const resolveIdentity = cache(async (): Promise<IdentityContext | null> => {
  const session = await resolveSession();
  if (!session) return null;
  return {
    authUser: session.authUser,
    organizationId: session.organizationId,
    user: identityUser(session.data.user),
    workspaces: session.data.workspaces.map((entry: IdentityDto["workspaces"][number]) => ({
      workspace: {
        id: entry.id,
        name: entry.name,
        slug: entry.slug,
      },
      role: entry.role,
    })),
  };
});

const resolveAuthContext = cache(async (): Promise<AuthContext | null> => {
  const [session, identity] = await Promise.all([resolveSession(), resolveIdentity()]);
  if (!session || !identity || !session.data.activeWorkspaceId) return null;
  const active = identity.workspaces.find(
    (entry) => entry.workspace.id === session.data.activeWorkspaceId,
  );
  if (!active) return null;
  return {
    ...identity,
    workspace: active.workspace,
    role: active.role,
  };
});

export async function currentIdentity(options: { optional: true }): Promise<IdentityContext | null>;
export async function currentIdentity(options?: { optional?: false }): Promise<IdentityContext>;
export async function currentIdentity(options: { optional?: boolean } = {}) {
  const identity = await resolveIdentity();
  if (!identity) {
    if (options.optional) return null;
    redirect("/signin");
  }
  return identity;
}

export async function currentUser(options: { optional: true }): Promise<AuthContext | null>;
export async function currentUser(options?: { optional?: false }): Promise<AuthContext>;
export async function currentUser(options: { optional?: boolean } = {}) {
  const identity = await resolveIdentity();
  if (!identity) {
    if (options.optional) return null;
    redirect("/signin");
  }
  const context = await resolveAuthContext();
  if (!context) {
    if (options.optional) return null;
    redirect("/onboarding");
  }
  return context;
}

function identityUser(user: IdentityDto["user"]): IdentityUser {
  return {
    workosUserId: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
    timezone: user.timezone,
    botsEnabled: user.botsEnabled === true,
    autoModelRoutingEnabled: user.autoModelRoutingEnabled,
    approveForMeEnabled: user.approveForMeEnabled,
    chatCapabilitiesBetaEnabled: user.chatCapabilitiesBetaEnabled,
    reviewInboxEnabled: user.reviewInboxEnabled,
    sidebarProjectsEnabled: user.sidebarProjectsEnabled,
    subagentsEnabled: user.subagentsEnabled,
    companyAgentsEnabled: user.companyAgentsEnabled,
    pastSessionAccessEnabled: user.pastSessionAccessEnabled,
    imessageEnabled: user.imessageEnabled,
    whatsappEnabled: user.whatsappEnabled,
    wikiEnabled: true,
    taskViewMode: user.taskViewMode,
    taskTimeRange: user.taskTimeRange,
    preferredMcpClient: user.preferredMcpClient,
    mcpSetupCompletedAt: user.mcpSetupCompletedAt ? new Date(user.mcpSetupCompletedAt) : null,
    onboardedAt: user.onboardedAt ? new Date(user.onboardedAt) : null,
    createdAt: new Date(user.createdAt),
    updatedAt: new Date(user.updatedAt),
  };
}
