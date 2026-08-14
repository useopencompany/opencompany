# @opencompany/ui

The opencompany design system — a shadcn-style component library built on
[Base UI](https://base-ui.com) and Tailwind CSS v4. Components are owned source
(not a black-box dependency), styled with design tokens that follow shadcn naming
but carry the opencompany palette.

## Usage

Load the tokens + Tailwind once in your app's stylesheet:

```css
/* app/globals.css */
@import "@opencompany/ui/globals.css";
```

Then import components and utilities directly:

```tsx
import { Button } from "@opencompany/ui/components/button";
import { cn } from "@opencompany/ui/lib/utils";
import { Search } from "@opencompany/ui/icons";

<Button>
  <Search /> Search
</Button>;
```

In a consuming Next.js app, transpile the package (it ships TypeScript source):

```ts
// next.config.mjs
const nextConfig = { transpilePackages: ["@opencompany/ui"] };
```

## Structure

| Path | Contents |
| --- | --- |
| `src/components/*` | One file per component (Base UI based). |
| `src/lib/utils.ts` | `cn()` class-merge helper. |
| `src/icons/*` | Icons (`@opencompany/ui/icons`): Lucide re-export + project-owned brand/provider logos (`BrandMark`, `OpenAIIcon`, `AnthropicIcon`, …). |
| `src/styles/globals.css` | Tailwind import, design tokens, base layer. |

## Theming

Tokens are defined in `src/styles/globals.css` using shadcn names
(`background`, `foreground`, `primary`, `muted`, `accent`, `destructive`, …) plus
opencompany semantics (`success`, `warning`, `info`, `brand`, `sidebar`, …). Dark
mode is driven by `data-theme="dark"` with a `prefers-color-scheme` fallback —
the same convention used in opencompany.

## Adding components

Browse and preview everything in the docs app (`apps/design-system`,
`bun run dev:ds`). To add a new shadcn/Base UI component, drop a file in
`src/components/`, wire it to the tokens, and add a demo to the docs registry.
