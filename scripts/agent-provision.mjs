// Provisions the shared agent dev user in the WorkOS environment selected by
// WORKOS_API_KEY: the user (password auth), the "Agent Dev" organization, and an
// admin membership. Idempotent. When a password is created or rotated it is
// written only to .env.agent.local (gitignored, mode 600) so it can be moved
// into Infisical without the value ever reaching a terminal or log.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import "./load-env.mjs";
import { WorkOS } from "@workos-inc/node";

const ORGANIZATION_NAME = "Agent Dev";
const CREDENTIALS_PATH = ".env.agent.local";

const rotatePassword = process.argv.includes("--rotate-password");
const emailFlagIndex = process.argv.indexOf("--email");
const email =
  (emailFlagIndex >= 0 ? process.argv[emailFlagIndex + 1] : undefined) ??
  process.env.OPENCOMPANY_AGENT_USER_EMAIL?.trim();

if (!email) {
  throw new Error(
    "Pass --email <address> or set OPENCOMPANY_AGENT_USER_EMAIL to provision the agent dev user.",
  );
}
if (!process.env.WORKOS_API_KEY) {
  throw new Error("WORKOS_API_KEY is required. Run `bun run setup` first.");
}
if (process.env.WORKOS_API_KEY.startsWith("sk_live_")) {
  throw new Error("Refusing to provision the agent dev user in a production WorkOS environment.");
}

const workos = new WorkOS(process.env.WORKOS_API_KEY);

let user = (await workos.userManagement.listUsers({ email })).data[0];
let password;
if (!user) {
  password = randomBytes(24).toString("base64url");
  user = await workos.userManagement.createUser({
    email,
    password,
    emailVerified: true,
    firstName: "Agent",
    lastName: "Dev",
  });
  console.log(`Created WorkOS user ${user.id} for ${email}.`);
} else if (rotatePassword) {
  password = randomBytes(24).toString("base64url");
  await workos.userManagement.updateUser({ userId: user.id, password });
  console.log(`Rotated the password for WorkOS user ${user.id}.`);
} else {
  console.log(`WorkOS user ${user.id} already exists for ${email}.`);
}

let organization = (await workos.organizations.listOrganizations({ limit: 100 })).data.find(
  (candidate) => candidate.name === ORGANIZATION_NAME,
);
if (organization) {
  console.log(`Organization "${ORGANIZATION_NAME}" already exists (${organization.id}).`);
} else {
  organization = await workos.organizations.createOrganization({ name: ORGANIZATION_NAME });
  console.log(`Created organization "${ORGANIZATION_NAME}" (${organization.id}).`);
}

const memberships = await workos.userManagement.listOrganizationMemberships({
  userId: user.id,
  organizationId: organization.id,
});
if (memberships.data.length === 0) {
  await workos.userManagement.createOrganizationMembership({
    userId: user.id,
    organizationId: organization.id,
    roleSlug: "admin",
  });
  console.log("Created the admin organization membership.");
} else {
  console.log("Organization membership already exists.");
}

if (password) {
  writeFileSync(
    CREDENTIALS_PATH,
    `OPENCOMPANY_AGENT_USER_EMAIL="${email}"\nOPENCOMPANY_AGENT_USER_PASSWORD="${password}"\n`,
    { mode: 0o600 },
  );
  console.log(
    `Wrote credentials to ${CREDENTIALS_PATH}. Store them with:\n` +
      `  infisical secrets set --env=dev --path=/web --file=${CREDENTIALS_PATH}\n` +
      `then delete ${CREDENTIALS_PATH}.`,
  );
} else {
  console.log("Password unchanged; pass --rotate-password to mint a new one.");
}
