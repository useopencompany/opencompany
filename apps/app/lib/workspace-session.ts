import { switchToOrganization } from "@workos-inc/authkit-nextjs";
import { cookies } from "next/headers";

export const ACTIVE_WORKSPACE_COOKIE = "goat-active-workspace";
export const ACTIVE_BRAIN_COOKIE = "goat-active-brain";

const ACTIVE_RESOURCE_COOKIE_OPTIONS = {
  path: "/",
  sameSite: "lax" as const,
  maxAge: 60 * 60 * 24 * 365,
};

export async function rememberActiveWorkspace(input: {
  workspaceId: string;
  brainId: string | null;
}) {
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, input.workspaceId, ACTIVE_RESOURCE_COOKIE_OPTIONS);
  if (input.brainId) {
    cookieStore.set(ACTIVE_BRAIN_COOKIE, input.brainId, ACTIVE_RESOURCE_COOKIE_OPTIONS);
  } else {
    cookieStore.delete(ACTIVE_BRAIN_COOKIE);
  }
}

export async function activateWorkspace(input: {
  workspaceId: string;
  workosOrganizationId: string;
  brainId: string | null;
}) {
  // WorkOS owns organization-scoped authentication, including any SSO/MFA
  // redirect. opencompany's cookies only remember which local resources to render
  // after AuthKit has switched the session.
  await switchToOrganization(input.workosOrganizationId, {
    revalidationStrategy: "none",
  });
  await rememberActiveWorkspace(input);
}
