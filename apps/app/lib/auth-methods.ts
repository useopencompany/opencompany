import { AuthenticationException, type AuthenticationResponse } from "@workos-inc/node";
import { cookies } from "next/headers";

export type AuthMethod = "google" | "magic_link";

const LAST_AUTH_METHOD_COOKIE = "goat-last-auth-method";
const OAUTH_STATE_COOKIE = "goat-oauth-state";
const ORGANIZATION_SELECTION_COOKIE = "goat-organization-selection";

export type OrganizationOption = {
  id: string;
  name: string;
};

type OrganizationSelection = {
  pendingAuthenticationToken: string;
  organizations: OrganizationOption[];
  returnPathname: string;
};

export type OAuthStateCookiePayload = {
  state: string;
  invitationToken?: string;
  returnPathname?: string;
};

// Normalize a return target from an unauthenticated cookie to a same-origin
// path, rejecting absolute and protocol-relative URLs before redirecting.
export function safeReturnPathname(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";

  const baseUrl = new URL("https://goat.invalid");
  try {
    const url = new URL(value, baseUrl);
    if (url.origin !== baseUrl.origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export function organizationSelectionFromError(
  error: unknown,
): Omit<OrganizationSelection, "returnPathname"> | null {
  if (
    !(error instanceof AuthenticationException) ||
    error.code !== "organization_selection_required" ||
    !error.pendingAuthenticationToken
  ) {
    return null;
  }

  const organizations = (error.rawData.organizations ?? []).flatMap((organization) => {
    const id = organization.id.trim();
    const name = organization.name.trim();
    return id && name ? [{ id, name }] : [];
  });
  if (organizations.length === 0) return null;

  return {
    pendingAuthenticationToken: error.pendingAuthenticationToken,
    organizations,
  };
}

function toAuthMethod(method: AuthenticationResponse["authenticationMethod"]): AuthMethod | null {
  if (method === "GoogleOAuth") return "google";
  if (method === "MagicAuth") return "magic_link";
  return null;
}

// WorkOS's hosted AuthKit shows a "last used" badge on sign-in; there is no API for
// it, so we replicate it ourselves with a first-party, browser-scoped cookie.
export async function recordLastAuthMethod(
  authenticationMethod: AuthenticationResponse["authenticationMethod"],
) {
  const method = toAuthMethod(authenticationMethod);
  if (!method) return;
  const cookieStore = await cookies();
  cookieStore.set(LAST_AUTH_METHOD_COOKIE, method, {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function readLastAuthMethod(): Promise<AuthMethod | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(LAST_AUTH_METHOD_COOKIE)?.value;
  return value === "google" || value === "magic_link" ? value : null;
}

// Short-lived CSRF cookie for the Google OAuth leg: we generate `state`
// ourselves (rather than going through authkit-nextjs's hosted-only helpers)
// so we can target the GoogleOAuth provider directly instead of WorkOS's picker.
export async function setOAuthStateCookie(payload: OAuthStateCookiePayload) {
  const cookieStore = await cookies();
  cookieStore.set(OAUTH_STATE_COOKIE, JSON.stringify(payload), {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10,
  });
}

export async function consumeOAuthStateCookie(): Promise<OAuthStateCookiePayload | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
  // Must match the path the cookie was set with (see setOAuthStateCookie)
  // or the browser treats this as a no-op deletion of a different cookie,
  // leaving the original — still consumable — state cookie in place.
  cookieStore.delete({ name: OAUTH_STATE_COOKIE, path: "/" });
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.state === "string" ? (parsed as OAuthStateCookiePayload) : null;
  } catch {
    return null;
  }
}

export async function setOrganizationSelection(
  selection: Omit<OrganizationSelection, "returnPathname"> & { returnPathname?: string },
) {
  const cookieStore = await cookies();
  const value = Buffer.from(
    JSON.stringify({
      ...selection,
      returnPathname: safeReturnPathname(selection.returnPathname),
    } satisfies OrganizationSelection),
  ).toString("base64url");
  cookieStore.set(ORGANIZATION_SELECTION_COOKIE, value, {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 10,
  });
}

async function readOrganizationSelection(): Promise<OrganizationSelection | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(ORGANIZATION_SELECTION_COOKIE)?.value;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<OrganizationSelection>;
    if (
      typeof parsed.pendingAuthenticationToken !== "string" ||
      !Array.isArray(parsed.organizations)
    ) {
      return null;
    }
    const organizations = parsed.organizations.flatMap((organization) => {
      if (!organization || typeof organization !== "object") return [];
      const id = typeof organization.id === "string" ? organization.id.trim() : "";
      const name = typeof organization.name === "string" ? organization.name.trim() : "";
      return id && name ? [{ id, name }] : [];
    });
    if (!parsed.pendingAuthenticationToken || organizations.length === 0) return null;
    return {
      pendingAuthenticationToken: parsed.pendingAuthenticationToken,
      organizations,
      returnPathname: safeReturnPathname(parsed.returnPathname),
    };
  } catch {
    return null;
  }
}

export async function readOrganizationOptions(): Promise<OrganizationOption[] | null> {
  const selection = await readOrganizationSelection();
  return selection?.organizations ?? null;
}

export async function readPendingOrganizationSelection() {
  return readOrganizationSelection();
}

export async function clearOrganizationSelection() {
  const cookieStore = await cookies();
  cookieStore.delete(ORGANIZATION_SELECTION_COOKIE);
}
