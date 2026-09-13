// Mints a real WorkOS session for the agent dev user and writes the sealed
// wos-session cookie value to stdout, so agents and scripts can drive the local
// dev server through the production auth path:
//   curl -H "Cookie: wos-session=$(node scripts/agent-session.mjs)" http://localhost:3002/
// The seal uses this environment's WORKOS_COOKIE_PASSWORD, so the middleware
// accepts the cookie exactly like one issued by the sign-in callback.
import "./load-env.mjs";
import { WorkOS } from "@workos-inc/node";

const required = [
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
  "OPENCOMPANY_AGENT_USER_EMAIL",
  "OPENCOMPANY_AGENT_USER_PASSWORD",
];
const missing = required.filter((key) => !process.env[key]?.trim());
if (missing.length > 0) {
  throw new Error(
    `Missing env: ${missing.join(", ")}. Run \`bun run setup\` (agent credentials live in ` +
      "Infisical dev /web; provision them with `bun run agent:provision`).",
  );
}

const workos = new WorkOS(process.env.WORKOS_API_KEY);
const clientId = process.env.WORKOS_CLIENT_ID;
const session = {
  sealSession: true,
  cookiePassword: process.env.WORKOS_COOKIE_PASSWORD,
};

let authenticated;
try {
  authenticated = await workos.userManagement.authenticateWithPassword({
    clientId,
    email: process.env.OPENCOMPANY_AGENT_USER_EMAIL,
    password: process.env.OPENCOMPANY_AGENT_USER_PASSWORD,
    session,
  });
} catch (error) {
  // Users in more than one organization must pick one before a session exists.
  const raw = error?.rawData ?? {};
  const pendingToken = raw.pending_authentication_token;
  const organizationId = raw.organizations?.[0]?.id;
  if (!pendingToken || !organizationId) throw error;
  authenticated = await workos.userManagement.authenticateWithOrganizationSelection({
    clientId,
    pendingAuthenticationToken: pendingToken,
    organizationId,
    session,
  });
}

if (!authenticated.sealedSession) {
  throw new Error("WorkOS did not return a sealed session.");
}

const cookieName = process.env.WORKOS_COOKIE_NAME?.trim() || "wos-session";
console.error(`Sealed ${cookieName} cookie for ${authenticated.user.email} written to stdout.`);
process.stdout.write(`${authenticated.sealedSession}\n`);
