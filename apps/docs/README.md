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
