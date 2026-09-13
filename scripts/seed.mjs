// Seeds the branch-isolated dev database with the agent dev user, its
// workspace, and an admin membership in the goat product schema, so a session
// minted by scripts/agent-session.mjs resolves to a real onboarded workspace.
// The workspace keeps the user's WorkOS organization id, which stops identity
// reads from creating organizations at runtime.
import { randomUUID } from "node:crypto";
import "./load-env.mjs";
import { neon } from "@neondatabase/serverless";
import { WorkOS } from "@workos-inc/node";

const WORKSPACE_NAME = "Agent Dev";

const missing = ["DATABASE_URL", "WORKOS_API_KEY", "OPENCOMPANY_AGENT_USER_EMAIL"].filter(
  (key) => !process.env[key]?.trim(),
);
if (missing.length > 0) {
  throw new Error(`Missing env: ${missing.join(", ")}. Run \`bun run setup\` first.`);
}

const email = process.env.OPENCOMPANY_AGENT_USER_EMAIL.trim();
const workos = new WorkOS(process.env.WORKOS_API_KEY);

const user = (await workos.userManagement.listUsers({ email })).data[0];
if (!user) {
  throw new Error(`WorkOS has no user for ${email}. Run \`bun run agent:provision\` first.`);
}
const membership = (
  await workos.userManagement.listOrganizationMemberships({
    userId: user.id,
    statuses: ["active"],
  })
).data[0];
if (!membership) {
  throw new Error(
    `WorkOS user ${user.id} has no organization membership. Run \`bun run agent:provision\` first.`,
  );
}

const sql = neon(process.env.DATABASE_URL);
const now = new Date();

await sql`
  insert into goat.users (workos_user_id, email, first_name, last_name, onboarded_at, updated_at)
  values (${user.id}, ${user.email}, ${user.firstName}, ${user.lastName}, ${now}, ${now})
  on conflict (workos_user_id) do update set
    email = excluded.email,
    onboarded_at = coalesce(users.onboarded_at, excluded.onboarded_at),
    updated_at = excluded.updated_at
`;

const [workspace] = await sql`
  insert into goat.workspaces (id, workos_organization_id, name, created_by_workos_id, updated_at)
  values (${`workspace_${randomUUID()}`}, ${membership.organizationId}, ${WORKSPACE_NAME}, ${user.id}, ${now})
  on conflict (workos_organization_id) do update set updated_at = excluded.updated_at
  returning id
`;

await sql`
  insert into goat.workspace_members (id, workspace_id, user_workos_id, role, updated_at)
  values (${`goat_wsm_${randomUUID()}`}, ${workspace.id}, ${user.id}, 'admin', ${now})
  on conflict (workspace_id, user_workos_id) do nothing
`;

console.log(`Seeded ${email} (${user.id}) into workspace ${workspace.id} ("${WORKSPACE_NAME}").`);
