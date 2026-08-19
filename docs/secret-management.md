# Secret management

Infisical is the source of truth for shared development and production secrets. Do not commit
secrets, paste them into logs, or copy production values into tracked files.

## Local development

Authenticate the Infisical CLI, then run `bun run setup`. The setup script pulls `dev` `/web` and
`/runner`, writes only gitignored local env files, generates branch-local values, and creates a
branch-isolated Neon database. `bun run env:pull` refreshes shared values without replacing the
branch database. `bun run setup -- --check` reports missing requirements without writing.

The tracked `.infisical.json` contains only opencompany's non-secret project selector. Authentication
and project authorization remain in the Infisical CLI's local credential store; never commit tokens
or exported secrets. `vercel link` writes the local, gitignored `.vercel/project.json` binding when
Vercel access is needed. Conductor uses `.worktreeinclude` to copy that Vercel binding into new local
workspaces.

## Production

Edit secrets in the runtime's Infisical path and verify the integration sync on the destination:

- Web: deployment path `prod` `/web` → Vercel product project.
- API: `prod` `/api` → Render product API.
- Runner: `prod` `/runner` → Render runner.
- Release automation: `prod` `/release` → GitHub Actions through `infisical run`.

After changing a required value, run the release preflight and deploy the affected runtime. A value
existing in Infisical is not sufficient evidence until the destination reports it and the runtime
health/smoke path succeeds.

Rotate a secret immediately if any command prints it unexpectedly. Update every consumer, deploy,
verify the new credential, and revoke the old one. Record IDs and verification outcomes, never the
secret value itself.
