# opencompany documentation app

`apps/docs` is the user- and API-facing Fumadocs site. Contributor and operational documentation
stays in the repository root `docs/` directory.

Run it from the repository root:

```bash
bun run dev:docs
bun run build:docs
```

The app owns normal `dev`, `build`, `lint`, and `typecheck` Turbo tasks. `build` and `typecheck`
regenerate the API reference before Fumadocs indexes the content.

## OpenAPI reference

`bun --filter @opencompany/docs generate:openapi` reads
`packages/protocol/openapi/openapi.v1.json` and replaces only
`content/docs/api-reference/endpoints/`. That directory is generated and gitignored; do not edit or
link to an individual generated filename from hand-written content. The source contract is the only
reviewed API definition.

## Hosting

The canonical site is [docs.opencompany.cloud](https://docs.opencompany.cloud). Vercel project
`acta-9a62816e/opencompany-docs` hosts this app with:

- production branch: `main`;
- root directory: `apps/docs`;
- install command: `bun install --frozen-lockfile`; and
- build command: `bun run build`.

Vercel Git deployments are disabled in `vercel.json`. Pull requests verify affected docs code in the
credential-free CI workflow, and verified merges to `main` deploy the project through the protected
production release workflow. The release requires `DOCS_VERCEL_PROJECT_ID` in Infisical `prod`
`/release`, validates that the project root is `apps/docs`, builds a precompiled Vercel artifact, and
smoke-checks its immutable URL before promotion and before recording `production-docs` as successful.

After a production deployment, verify the homepage, search, and at least one generated endpoint
under `/docs/api-reference/endpoints/`. The generated endpoint filenames come from the protocol
contract and are intentionally not hand-maintained.

## Writing and maintaining user guides

Write for someone completing a job in the hosted product. Lead with what they can do, give the
prerequisites and exact UI path, show a realistic prompt, explain the expected result, and finish
with the next useful step or recovery path. Keep implementation and deployment details in the
repository documentation unless they explain a user-visible constraint.

The structure takes its cues from [Cursor's docs](https://cursor.com/docs) and
[quickstart](https://cursor.com/docs/get-started/quickstart): a short first-success path, focused
feature guides, concrete examples, and deeper reference material. Write original opencompany
instructions from verified product behavior; Cursor is an editorial reference, not a feature spec.

Before changing a claim, check its implementation:

- UI labels and settings paths: `apps/web/components/SettingsChrome.tsx`, `Routes.tsx`, and the
  relevant feature component.
- Brain source availability: `apps/web/lib/brain-sources/registry.ts` and `BrainSourceCards.tsx`.
- Plugin events: `docs/plugin-events.md`, `apps/web/components/OfficialMcpPluginSettings.tsx`, and `WorkflowEditor.tsx`.
- Roles and feature availability: `apps/api/src/auth.ts` and the relevant application service.
- Skills and Plugins: their Settings components, package manifests, and runtime permission checks.
- Tasks and Workflows: the task board, Workflow editor, application services, and runner behavior.
- Recent changes: root `CHANGELOG.md`, followed by the relevant code to confirm current behavior.

Preserve published page paths when reorganizing navigation. Keep source ingestion, live tools,
engine subscriptions, and legacy Brain distinct. Don't promise a picker, connection, or approval
flow that the current UI doesn't offer. Avoid hardcoding model catalogs and prices that already
have a live settings surface.

After content changes, run the docs build, lint, typecheck, and repository link checker. Verify
navigation, search, in-page links, mobile reading, and a generated API endpoint in the rendered site.
