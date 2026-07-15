import { getDb } from "@opencompany/db/client";
import { goatUsers } from "@opencompany/db/goat-schema";
import { eq } from "drizzle-orm";
import { jwtVerify } from "jose";
import { headers } from "next/headers";
import { jwksForAuthKitDomain, resolveGoatAuthKitDomain } from "@/lib/mcp-oauth";

// Bearer auth for native (mobile) clients. The Goat web app authenticates with
// the AuthKit sealed session cookie; native apps instead send the AuthKit
// access token (a JWT) as `Authorization: Bearer <token>`, verified against
// the same AuthKit JWKS the MCP connector uses. Unlike MCP tokens there is no
// resource-indicator audience on user access tokens, so only the issuer is
// pinned.
export async function resolveGoatBearerUserWorkosId(): Promise<string | null> {
  const headerStore = await headers();
  const authorization = headerStore.get("authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;

  const devUserId = await resolveDevBearerUserWorkosId(token);
  if (devUserId) return devUserId;

  const domain = resolveGoatAuthKitDomain();
  if (!domain.ok) return null;

  try {
    const { payload } = await jwtVerify(token, jwksForAuthKitDomain(domain.domain), {
      issuer: domain.domain,
    });
    return typeof payload.sub === "string" && payload.sub.trim() ? payload.sub : null;
  } catch {
    return null;
  }
}

// Local-development shortcut: a static token mapped to a user email, so the
// mobile app can talk to a local dev server before the WorkOS native OAuth
// client is configured. Requires both env vars and never activates in
// production builds.
async function resolveDevBearerUserWorkosId(token: string): Promise<string | null> {
  if (process.env.NODE_ENV === "production") return null;
  const devToken = process.env.GOAT_MOBILE_DEV_TOKEN?.trim();
  const devEmail = process.env.GOAT_MOBILE_DEV_USER_EMAIL?.trim();
  if (!devToken || !devEmail || token !== devToken) return null;

  const [user] = await getDb()
    .select({ workosUserId: goatUsers.workosUserId })
    .from(goatUsers)
    .where(eq(goatUsers.email, devEmail))
    .limit(1);
  return user?.workosUserId ?? null;
}
