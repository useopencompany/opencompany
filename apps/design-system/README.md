# @opencompany/design-system

The documentation & showcase site for the OpenCompany design system, modeled on
[ds.meetjamie.ai](https://ds.meetjamie.ai/). It consumes `@opencompany/ui` and
documents the foundations (colors, typography, corner radius, icons) and every
component with live previews.

## Develop

```bash
bun run dev:ds        # from the repo root → http://localhost:3001
```

## How it works

- **`lib/site.ts`** — navigation model (foundations + component slugs).
- **`lib/registry.tsx`** — live demos keyed by component slug.
- **`app/components/[slug]`** — one statically generated page per component.
- **`app/foundations/*`** — token, type, radius, and icon references.
- **`components/docs-shell.tsx`** — sidebar + header layout.
- **`components/command-menu.tsx`** — ⌘K palette to jump between pages.
- Theme switching uses `next-themes` on the `data-theme` attribute, matching the
  package tokens.

## Adding a component to the docs

1. Add the component to `@opencompany/ui`.
2. Add its slug + title to `lib/site.ts`.
3. Add a `registry` entry with one or more example previews in `lib/registry.tsx`.
