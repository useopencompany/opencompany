# Typography System

Status: Design (2026-05-27). Implementation will land on its own branch off `main`, not on the current composer branch.

## Goals

1. **Replace 305 hardcoded `text-[Npx]` occurrences** across `apps/web` with a small set of semantic tokens.
2. **Make the app respect user font-size preferences** — Cmd+/- and "Zoom Text Only" in Safari, system display-scale on macOS/iOS, and any future Dynamic-Type-like setting must scale the chat content.
3. **Match the Perplexity / ChatGPT camp** of modern AI chat UIs — slightly more generous reading width than Linear, but tighter UI chrome (sidebar, inspector, metadata) than a pure 16px-everywhere setup.

## Non-Goals

- Changing fonts, weights, or letter-spacing. This work is size-only.
- Re-styling existing components. Visual layout stays as it is; only the size variable behind each text element changes.
- Touching `apps/runner`, `apps/inngest-dev`, `apps/stripe-webhooks`. Scope is `apps/web` only.

## The Scale (Variant B — Perplexity-leaning)

`<html>` font-size stays at the browser default (100% = 16px). Every token below is expressed in `rem`, so the entire scale moves up or down with the user's browser/OS preference.

| Token | rem | px @ 100% | Used for |
|---|---|---|---|
| `--text-micro` | `0.6875rem` | 11px | kbd hints, uppercase mini-labels |
| `--text-caption` | `0.75rem` | 12px | timestamps, secondary metadata |
| `--text-body-s` | `0.8125rem` | 13px | UI chrome — sidebar entries, inspector values, tool-call cards |
| `--text-body` | `0.9375rem` | **15px** | **default — chat messages, composer textarea, primary body** |
| `--text-emphasis` | `1.0625rem` | 17px | lead paragraph, empty-state subtitle |
| `--text-heading` | `1.375rem` | 22px | section headings (h2 / h3) |
| `--text-display` | `1.875rem` | 30px | page titles (h1) |

The seven tokens collapse all current 23 distinct px values down to a clean ladder. Halves (`12.5`, `13.5`, `11.5`) disappear.

### Line-heights

Each token gets a paired line-height so the typographic rhythm stays consistent. Tailwind classes that already pair size+leading (`text-[13px] leading-6`) get migrated as a unit.

| Token | Line-height (rem) |
|---|---|
| `--text-micro` | `1rem` |
| `--text-caption` | `1.125rem` |
| `--text-body-s` | `1.25rem` |
| `--text-body` | `1.5rem` |
| `--text-emphasis` | `1.625rem` |
| `--text-heading` | `1.75rem` |
| `--text-display` | `2.25rem` |

## How tokens are exposed to components

CSS custom properties live in `apps/web/app/globals.css` under the existing `@theme { ... }` block. Tailwind v4 reads `--text-*` and auto-generates utility classes (per the v4 theme system).

```css
@theme {
  /* existing color tokens stay */
  --color-canvas: #f7f7f5;
  /* ... */

  /* new type tokens */
  --text-micro: 0.6875rem;
  --text-micro--line-height: 1rem;
  --text-caption: 0.75rem;
  --text-caption--line-height: 1.125rem;
  --text-body-s: 0.8125rem;
  --text-body-s--line-height: 1.25rem;
  --text-body: 0.9375rem;
  --text-body--line-height: 1.5rem;
  --text-emphasis: 1.0625rem;
  --text-emphasis--line-height: 1.625rem;
  --text-heading: 1.375rem;
  --text-heading--line-height: 1.75rem;
  --text-display: 1.875rem;
  --text-display--line-height: 2.25rem;
}
```

Component code then uses Tailwind utility classes:

```tsx
<p className="text-body">Hello world</p>
<span className="text-caption text-ink-muted">just now</span>
<h2 className="text-heading font-semibold">Session is ready</h2>
```

No CSS variable lookups (`var(...)`) at call sites. Only the utility classes.

## Migration mapping

Every existing `text-[Npx]` occurrence maps to one of the seven tokens by this rule:

| Current `text-[Npx]` | Count | Becomes | Notes |
|---|---:|---|---|
| `8.5px` · `9px` · `9.5px` · `10px` · `10.5px` · `11px` | 57 | `text-micro` | One step up where currently 8.5–10. |
| `11.5px` · `12px` · `12.5px` | 162 | `text-caption` | Halves collapse to whole. |
| `13px` · `13.5px` | 60 | `text-body-s` | UI chrome size. |
| `14px` | 14 | `text-body` | Chat-content-adjacent. Bumped slightly (14→15) to match Perplexity body. |
| `15px` · `16px` | 4 | `text-body` | All four collapse to `text-body`. Reviewer can promote to `text-emphasis` for lead/empty-state copy during the bulk sweep if it reads better. |
| `18px` · `20px` · `22px` | 9 | `text-heading` | All consolidate to 22px. |
| `24px` · `28px` · `34px` | 4 | `text-display` | All consolidate to 30px. |

Line-height pairings (`leading-5`, `leading-6`, etc.) follow the table in the previous section — any explicit `leading-N` adjacent to a `text-[Npx]` gets removed because the token carries its own line-height.

## What changes visually

- **Chat messages and composer** get a touch bigger (13→15px). Easier to read.
- **Sidebar entries and inspector** stay close to today (12.5→12, 13→13). Negligible change.
- **`<kbd>` hints, uppercase labels, inspector field names** consolidate to 11–12px. A few currently-10.5px labels grow by half a pixel.
- **Headings** become more present — current 18/20/22 all jump to 22; current 24/28/34 all settle at 30.
- **Cmd+/- works.** "Zoom Text Only" in Safari starts working. macOS Dynamic Type-equivalent settings scale the app.

## Migration plan

The implementation lives in its own branch off `main` (not on the current PRO-89 composer branch). The order:

1. **Tokens** — add the seven `--text-*` custom properties + line-heights to `apps/web/app/globals.css`.
2. **`SessionView.tsx`** — migrate the chat surface first (highest visibility, most edited). Use this file as the pattern reference.
3. **Visual review** — open `localhost:3000`, screenshot before/after, confirm with stakeholder. No commits past this point until visual sign-off.
4. **Bulk migration** — sweep the remaining ~28 `apps/web/components/*.tsx` and `apps/web/app/**/*.tsx` files. Driven by an automated mapping (see below), one commit per file or per logical group.
5. **Cleanup** — remove the temporary `text-[14px]` on `<body>` in `layout.tsx`. Remove now-unused `leading-N` classes that were paired with old sizes.
6. **Lint + manual smoke test** — run `bun run lint`, walk through every top-level route, look for layout breaks.

### Automation for the bulk sweep

A simple mapping script (not committed; throw-away):

```sh
# In apps/web, replace explicit px sizes with token classes.
# Run per file, review diff, commit if happy.
sd 'text-\[(8\.5|9|9\.5|10|10\.5|11)px\]' 'text-micro'     <file>
sd 'text-\[(11\.5|12|12\.5)px\]'           'text-caption'  <file>
sd 'text-\[(13|13\.5)px\]'                 'text-body-s'   <file>
sd 'text-\[14px\]'                         'text-body'     <file>
sd 'text-\[(15|16)px\]'                    'text-body'     <file>
sd 'text-\[(18|20|22)px\]'                 'text-heading'  <file>
sd 'text-\[(24|28|34)px\]'                 'text-display'  <file>
```

Adjacent `leading-N` removal needs a manual pass — too context-dependent for `sd`.

## Risks

- **Layout regressions.** Containers sized for 13px content may need a small width increase when body becomes 15px. Inventory file-by-file during the bulk sweep.
- **Off-by-half on micro-labels.** Some 10.5px labels become 11px — slightly larger. Test that the inspector field stack doesn't wrap awkwardly.
- **Headings get LOUDER.** Combining 18+20+22 into 22 makes some previously-small headings bigger. Acceptable; consistent hierarchy.
- **Other workspaces (inngest-dev, runner) untouched.** Their tokens diverge after this change. Documented as scope intentionally.

## Decision log

- **Base font-size:** 100% (16px). Considered 87.5% (14px) but rejected — most AI-chat apps stay on browser default and rely on dense chrome to compress UI, which is what tokens already do.
- **Body size:** 15px (Perplexity), not 16 (ChatGPT). Strikes a balance: more readable than current 13px, but doesn't blow up the dense Linear-style sidebar/inspector that the team has tuned.
- **Number of tokens:** 7. Fewer leaves too few options for fine-grained UI chrome; more reintroduces the chaos we're trying to remove.
- **Naming:** semantic (`body`, `heading`, `display`) not scale (`xs`, `sm`, `md`). Forces intent at call-sites and makes future renames possible.
