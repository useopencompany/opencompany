import type { IdentityDto } from "@opencompany/protocol";
import { saveSession, withAuth } from "@workos-inc/authkit-nextjs";
import type { AuthenticationResponse, User as WorkOSUser } from "@workos-inc/node";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { cache } from "react";
import { recordLastGoatAuthMethod } from "@/lib/auth-methods";
import { serverApiClient, serverApiError } from "@/lib/server-api-client";
import {
  GOAT_ACTIVE_BRAIN_COOKIE,
  GOAT_ACTIVE_WORKSPACE_COOKIE,
  rememberActiveGoatWorkspace,
} from "@/lib/workspace-session";

export { GOAT_ACTIVE_BRAIN_COOKIE, GOAT_ACTIVE_WORKSPACE_COOKIE };

export type GoatIdentityUser = {
  workosUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  timezone: string;
  taskSpawningEnabled: boolean;
  autoModelRoutingEnabled: boolean;
  chatCapabilitiesBetaEnabled: boolean;
  imessageEnabled: boolean;
  wikiEnabled: boolean;
  taskViewMode: "board" | "list";
  preferredMcpClient: "claude" | "chatgpt" | "cursor" | null;
  mcpSetupCompletedAt: Date | null;
  onboardedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GoatIdentityWorkspace = {
  id: string;
  name: string;
  slug: string | null;
};

export type GoatWorkspaceWithRole = {
  workspace: GoatIdentityWorkspace;
  role: "admin" | "member";
};

export type GoatIdentityBrain = IdentityDto["brains"][number];

export type GoatIdentityContext = {
  authUser: WorkOSUser;
  organizationId: string | null;
  user: GoatIdentityUser;
  workspaces: GoatWorkspaceWithRole[];
};

export type GoatAuthContext = {
  authUser: WorkOSUser;
  organizationId: string | null;
  user: GoatIdentityUser;
  workspace: GoatIdentityWorkspace;
  role: "admin" | "member";
  workspaces: GoatWorkspaceWithRole[];
  brains: GoatIdentityBrain[];
  activeBrain: GoatIdentityBrain | null;
};

// Shared by both custom sign-in surfaces. WorkOS session sealing and browser
// preference cookies remain in Next.js; all identity persistence and membership
// adoption run through the authenticated API identity tier.
export async function completeGoatAuthentication(
  authResponse: AuthenticationResponse,
  request: NextRequest | string,
) {
  await saveSession(authResponse, request);
  await recordLastGoatAuthMethod(authResponse.authenticationMethod);
  const client = await serverApiClient({ authorization: `Bearer ${authResponse.accessToken}` });
  const response = await client.v1.identity.sync.$post();
  if (!response.ok) {
    throw await serverApiError(response, "Could not synchronize the authenticated identity.");
  }
  const { data } = await response.json();
  if (authResponse.organizationId && data.activeWorkspaceId) {
    try {
      await rememberActiveGoatWorkspace({
        workspaceId: data.activeWorkspaceId,
        brainId: data.activeBrainId,
      });
    } catch (error) {
      console.error("[goat] Failed to activate the authenticated workspace", error);
    }
  }
}

// React cache() preserves the request-local semantics relied on by the RSC and
// route callers: every consumer shares one AuthKit read and one API identity read.
const resolveGoatSession = cache(
  async (): Promise<{
    authUser: WorkOSUser;
    organizationId: string | null;
    data: IdentityDto;
  } | null> => {
    const session = await withAuth();
    if (!session.user) return null;
    const response = await (await serverApiClient()).v1.identity.$get();
    if (!response.ok) throw await serverApiError(response, "Could not load your workspace.");
    const data = (await response.json()).data as IdentityDto;
    return {
      authUser: session.user,
      organizationId: session.organizationId ?? null,
      data,
    };
  },
);

const resolveGoatIdentity = cache(async (): Promise<GoatIdentityContext | null> => {
  const session = await resolveGoatSession();
  if (!session) return null;
  return {
    authUser: session.authUser,
    organizationId: session.organizationId,
    user: identityUser(session.data.user),
    workspaces: session.data.workspaces.map((entry: IdentityDto["workspaces"][number]) => ({
      workspace: { id: entry.id, name: entry.name, slug: entry.slug },
      role: entry.role,
    })),
  };
});

const resolveGoatAuthContext = cache(async (): Promise<GoatAuthContext | null> => {
  const [session, identity] = await Promise.all([resolveGoatSession(), resolveGoatIdentity()]);
  if (!session || !identity || !session.data.activeWorkspaceId) return null;
  const active = identity.workspaces.find(
    (entry) => entry.workspace.id === session.data.activeWorkspaceId,
  );
  if (!active) return null;
  return {
    ...identity,
    workspace: active.workspace,
    role: active.role,
    brains: session.data.brains,
    activeBrain:
      session.data.brains.find(
        (brain: IdentityDto["brains"][number]) => brain.id === session.data.activeBrainId,
      ) ?? null,
  };
});

export async function currentGoatIdentity(options: {
  optional: true;
}): Promise<GoatIdentityContext | null>;
export async function currentGoatIdentity(options?: {
  optional?: false;
}): Promise<GoatIdentityContext>;
export async function currentGoatIdentity(options: { optional?: boolean } = {}) {
  const identity = await resolveGoatIdentity();
  if (!identity) {
    if (options.optional) return null;
    redirect("/signin");
  }
  return identity;
}

export async function currentGoatUser(options: { optional: true }): Promise<GoatAuthContext | null>;
export async function currentGoatUser(options?: { optional?: false }): Promise<GoatAuthContext>;
export async function currentGoatUser(options: { optional?: boolean } = {}) {
  const identity = await resolveGoatIdentity();
  if (!identity) {
    if (options.optional) return null;
    redirect("/signin");
  }
  const context = await resolveGoatAuthContext();
  if (!context) {
    if (options.optional) return null;
    redirect("/onboarding");
  }
  return context;
}

export async function currentGoatBrain(): Promise<{
  context: GoatAuthContext;
  brain: GoatIdentityBrain;
}> {
  const context = await currentGoatUser();
  if (!context.activeBrain) {
    throw new Error("You do not have access to any brain in this workspace.");
  }
  return { context, brain: context.activeBrain };
}

export async function currentGoatBrainByRef(
  brainRef: string,
): Promise<{ context: GoatAuthContext; brain: GoatIdentityBrain }> {
  const context = await currentGoatUser();
  const brain = context.brains.find(
    (candidate) => candidate.id === brainRef || candidate.slug === brainRef,
  );
  if (!brain || brain.workspaceId !== context.workspace.id) {
    throw new Error("You do not have access to that brain.");
  }
  return { context, brain };
}

function identityUser(user: IdentityDto["user"]): GoatIdentityUser {
  return {
    workosUserId: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
    timezone: user.timezone,
    taskSpawningEnabled: user.taskSpawningEnabled,
    autoModelRoutingEnabled: user.autoModelRoutingEnabled,
    chatCapabilitiesBetaEnabled: user.chatCapabilitiesBetaEnabled,
    imessageEnabled: user.imessageEnabled,
    wikiEnabled: user.wikiEnabled,
    taskViewMode: user.taskViewMode,
    preferredMcpClient: user.preferredMcpClient,
    mcpSetupCompletedAt: user.mcpSetupCompletedAt ? new Date(user.mcpSetupCompletedAt) : null,
    onboardedAt: user.onboardedAt ? new Date(user.onboardedAt) : null,
    createdAt: new Date(user.createdAt),
    updatedAt: new Date(user.updatedAt),
  };
}
