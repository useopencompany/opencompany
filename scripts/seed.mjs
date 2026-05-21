import "./load-env.mjs";
import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to seed the database.");
}

const sql = neon(databaseUrl);
const now = new Date();
const userId = "usr_seed";
const workspaceId = "wks_usr_seed";

await sql`
  insert into users (
    id,
    workos_user_id,
    email,
    first_name,
    last_name,
    updated_at
  ) values (
    ${userId},
    'seed_workos_user',
    'dev@example.com',
    'Dev',
    'User',
    ${now}
  )
  on conflict (workos_user_id) do update set
    email = excluded.email,
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    updated_at = excluded.updated_at
`;

await sql`
  insert into workspaces (
    id,
    name,
    created_by_user_id,
    updated_at
  ) values (
    ${workspaceId},
    'Dev Workspace',
    ${userId},
    ${now}
  )
  on conflict (id) do nothing
`;

await sql`
  insert into workspace_memberships (
    workspace_id,
    user_id,
    role,
    updated_at
  ) values (
    ${workspaceId},
    ${userId},
    'owner',
    ${now}
  )
  on conflict (workspace_id, user_id) do nothing
`;

console.log("Seeded dev user and workspace.");
