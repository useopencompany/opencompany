# Mobile / Phone UI — Design Spec

**Date:** 2026-06-17
**Branch:** `mobile-ui-fixes`
**Status:** Draft for review

## Problem

The OpenCompany web app is buggy and hard to use on a phone. Evidence comes from two
sources that agree completely: Jasper's **real-device screenshots** (iPhone, Mobile Safari)
and a **code audit** of `apps/web`.

The core finding: **there is no mobile shell — the desktop layout is simply being squeezed
onto a phone.** Repo-wide there are only ~62 responsive breakpoint usages and the app shell
has none.

### Observed symptoms (from real device)

1. **Content crushed to a sliver** — long titles wrap one letter per line when the sidebar is open.
2. **Everything "jumps around" when opening a new chat** — layout reflows / shifts.
3. **"Chat isn't central"** — content position changes between empty and populated states.
4. **Accidental zoom** — focusing the composer zooms the page in and never zooms back.
5. **Composer send/stop button clipped** off the right edge.
6. **Safari's address bar is distracting** (Jasper's explicit ask to remove/shrink it).

## Root Causes (code-confirmed)

| # | Symptom | Root cause | Location |
|---|---------|-----------|----------|
| 1 | Crushed content, clipped composer | Desktop side-by-side shell; sidebar is an **in-flow 256px column**, not a phone drawer. On a 402px screen the sidebar eats 256px → content ~146px → minus `px-6` → ~98px. | `AppShell.tsx:66` (`flex h-screen w-screen`), `Sidebar.tsx:465-469` (`w-0`/`w-[256px]`), `MainPanel.tsx:265` |
| 2 | Vertical jump on scroll | `h-screen`/`w-screen` = `100vh`/`100vw`; Mobile Safari address-bar show/hide changes `100vh`. | `AppShell.tsx:66` |
| 3 | Jump on new chat, "not central" | `<main>` uses `items-center justify-center` → empty chat centers the hero, populated chat scrolls from top. The layout-mode flip *is* the jump. | `MainPanel.tsx:265` |
| 4 | Accidental zoom | Body base font is `text-[14px]`; composer textarea inherits a sub-16px font → iOS Safari **auto-zooms on input focus** and never returns. No `viewport` export to constrain scaling. | `layout.tsx:21`, no `viewport` export anywhere |
| 5 | Horizontal overflow | Consequence of #1 — panel wider than viewport pushes right-pinned controls off-screen. | derived |
| 6 | Distracting Safari chrome | No PWA — app always runs as a normal browser tab. No manifest, no Apple web-app meta, only SVG favicons. | (absent) |

## Goals / Non-Goals

**Goals**
- Below the `md` breakpoint, the phone UI is **stable** (no jumping), **readable** (full-width, no sliver), **thumb-friendly**, and has **no accidental zoom**.
- The app is **installable as a full-screen PWA** so Safari's address bar disappears (Add to Home Screen).
- **Desktop (≥ md) stays byte-for-byte unchanged** — every change is gated behind a mobile breakpoint or mobile detection.

**Non-Goals**
- No desktop redesign.
- No bottom-tab navigation (OC's nav is a session list — drawer-shaped, not tab-shaped). Revisit only if a real fixed-section IA emerges.
- Not building a real native app.

## Design

### Breakpoint strategy
- Use Tailwind `md` (768px) as the mobile/desktop divide. CSS breakpoints wherever the change is purely visual.
- A small client `useIsMobile()` (or breakpoint) signal where **stateful** behavior is required: drawer open/close, scrim, body-scroll-lock. (No such hook exists today — this is net-new and shared.)

### 1. Responsive shell + off-canvas drawer
- `AppShell`: below `md`, render the sidebar as an **off-canvas drawer** — `fixed inset-y-0 left-0 z-40`, translated off-screen when closed, on-screen when open, over a **scrim** (`fixed inset-0 bg-black/40 z-30`) with **body scroll lock** while open. Main content takes **full width** (sidebar out of flow on mobile).
- Above `md`: the current `flex` row is untouched.
- Drawer open-state lives in a provider at the client boundary so both the menu button and content can toggle it. **Close on:** scrim tap, nav-item tap, route change, Escape, swipe-left.
- **Thumb reach:** move/duplicate the menu + "new chat" trigger to a bottom-anchored, reachable position on mobile (exact placement decided in the plan; current toggle is `fixed left-2 top-3` = hardest one-handed corner).

### 2. Viewport-height stability
- Swap `h-screen` → `h-dvh` and `w-screen` → `w-full` in `AppShell` and any other `100vh`/`100vw` users (audit repo-wide).
- Ensure the composer stays above the on-screen keyboard using the dynamic viewport (visualViewport handling only if `dvh` alone is insufficient).

### 3. Stable content layout (kills the jump)
- Remove the empty↔populated centering flip in `MainPanel`. The layout **structure must be identical** whether the chat is empty or has messages: a single stable scroll container with the composer anchored; the "new chat" hero is centered *within* that stable container rather than changing the container's layout mode.

### 4. No accidental zoom
- Add a root `viewport` export: `width: 'device-width', initialScale: 1, maximumScale: 1, viewportFit: 'cover'`.
- The robust fix (Safari can ignore `maximumScale` for a11y): give the composer textarea and **all focusable inputs** a font-size **≥ 16px on mobile** (e.g. `text-[16px] md:text-[14px]`). Audit sidebar search + settings inputs.
- `viewportFit: 'cover'` + `env(safe-area-inset-*)` padding so content clears the notch / home indicator (important in standalone PWA).

### 5. Horizontal-overflow guard
- `overflow-x: hidden` on the mobile content container as a backstop, plus an audit of fixed-width descendants (`w-[…]`, `min-w-…`) that can exceed viewport width. The drawer + full-width content removes the primary cause; this catches stragglers.

### 6. PWA standalone (removes Safari's bar)
- Add `app/manifest.ts` (Next metadata route): `name`, `short_name`, `start_url: '/'`, `display: 'standalone'`, `background_color`, `theme_color`, maskable icons (192 / 512 PNG).
- Add Apple web-app metadata: `appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title }` + `apple-touch-icon` (180px PNG).
- Generate icon PNGs from the existing brand SVG.
- **Outcome:** Add to Home Screen → full-screen app, **no address bar, no bottom toolbar**. (This only applies to the installed/home-screen app, not a normal Safari tab — documented for Jasper.)

### Search bar — Jasper's ask
- **Safari's bar:** removed via the PWA standalone work above.
- **In-app sidebar search field** (`Sidebar.tsx:522`): **kept visible on mobile** (Jasper's call). The 16px font fix prevents focus-zoom; no hiding.

## Testing / Verification
- **Reproduce each bug in the iOS Simulator (logged in) before fixing** (verify-before-fix). The simulator is already booted with `idb` interaction working.
- After each change: re-check at iPhone widths + landscape; confirm **no desktop regression** at ≥ md via screenshots.
- Verify PWA via real Add-to-Home-Screen on Jasper's device (zoom, jump, full-screen).

## Rollout / Risk
- All mobile changes gated behind `md` / mobile detection → desktop is safe.
- Incremental, each independently verifiable, in priority order:
  1. Responsive shell + drawer (biggest win — fixes #1, #5, most of #3)
  2. `dvh` + stable centering (#2, #3)
  3. 16px inputs + viewport export (#4)
  4. PWA standalone + icons (#6, the search-bar ask)

## Open Questions
1. ~~In-app sidebar search — hide on mobile, make collapsible, or leave?~~ **RESOLVED: keep visible on mobile** (16px fix prevents zoom).
2. Exact placement of the thumb-reachable menu / new-chat control on mobile.
3. Status-bar style for the PWA (`black-translucent` vs `default`) — depends on the app's top color.
