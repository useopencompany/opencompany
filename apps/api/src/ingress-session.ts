import { getAppUrl } from "@opencompany/agent/app-url";
import { listWorkspacesForUser } from "@opencompany/db/workspaces";
import type { ApiIdentityVerifier } from "./auth";
import { ApiError } from "./errors";

type DbLike = any;

export type IngressWorkspace = {
  workspace: { id: string; workosOrganizationId: string | null };
  role: string;
};

export type IngressSession =
  | {
      kind: "actor";
      userId: string;
      workspaceId: string;
      role: string;
      workspaces: IngressWorkspace[];
      refreshedSessionCookie?: string;
    }
  | { kind: "redirect"; response: Response };

// The retired web OAuth routes resolved the hosted session with
// currentUser(): anonymous browsers redirect to /signin, users without a
// visible workspace to /onboarding, and the active workspace resolves
// org-match -> workspace cookie -> first visible workspace over the
// billing-filtered membership list. There is deliberately no onboarding gate:
// the onboarding wizard connects providers before onboarded_at is set.
export async function resolveIngressSession(
  input: { db: DbLike; identify: ApiIdentityVerifier },
  request: Request,
): Promise<IngressSession> {
  let identity: Awaited<ReturnType<ApiIdentityVerifier>>;
  try {
    identity = await input.identify(request);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return { kind: "redirect", response: webRedirect("/signin") };
    }
    throw error;
  }
  const workspaces: IngressWorkspace[] = await listWorkspacesForUser(identity.userId, {
    db: input.db,
  });
  const first = workspaces[0];
  if (!first) return { kind: "redirect", response: webRedirect("/onboarding") };
  const active =
    workspaces.find(
      (entry) =>
        identity.organizationId && entry.workspace.workosOrganizationId === identity.organizationId,
    ) ??
    workspaces.find((entry) => entry.workspace.id === identity.activeWorkspaceId) ??
    first;
  return {
    kind: "actor",
    userId: identity.userId,
    workspaceId: active.workspace.id,
    role: active.role,
    workspaces,
    ...(identity.refreshedSessionCookie
      ? { refreshedSessionCookie: identity.refreshedSessionCookie }
      : {}),
  };
}

export function webRedirect(path: string) {
  return Response.redirect(new URL(path, getAppUrl()), 302);
}

export function sessionRedirect(
  session: Extract<IngressSession, { kind: "actor" }>,
  target: URL | string,
) {
  const response = Response.redirect(target instanceof URL ? target : new URL(target), 302);
  if (!session.refreshedSessionCookie) return response;
  const withCookie = new Response(response.body, response);
  withCookie.headers.append("Set-Cookie", session.refreshedSessionCookie);
  return withCookie;
}
