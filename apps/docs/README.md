# OpenCompany documentation app

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

The app is included in the monorepo CI build but is not provisioned. Hosting and domain wiring are a
separate owner decision.
