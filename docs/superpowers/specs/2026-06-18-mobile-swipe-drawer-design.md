# Mobile swipe-to-open drawer — design

**Date:** 2026-06-18
**Branch:** `mobile-swipe-drawer` (off `main`)
**Status:** design approved (feel validated on a real iPhone via a throwaway prototype)

## Goal

Let mobile users open the navigation drawer by **dragging from the left side of the
screen** (ChatGPT-style), instead of only tapping the bottom-left menu button. The drawer
tracks the finger 1:1 and snaps open/closed on release. Desktop is untouched.

This builds directly on the off-canvas drawer shipped in PR #478 (`ShellChrome`,
`useDrawer()`, the scrim, `MobileMenuButton`) — it adds a gesture that drives the existing
open/closed transform; it does not rebuild the drawer.

## Scope

- **In:** edge-drag to **open** the menu; drag-left / tap-scrim / Escape to **close**.
  Applies to the **main workspace** (`AppShell` → `ShellChrome`) AND the **Personal
  space** (`PersonalShell`), so the swipe works on every authenticated screen.
- **Out (deferred, not in this change):** swipe-to-go-back / navigation pop (the
  Android/Samsung back gesture — explicitly rejected); per-chat row swipes
  (delete/rename). Tracked separately (OC-337/338).

## Validated feel (locked numbers, tuned on device)

| Knob | Value | Meaning |
|------|-------|---------|
| `EDGE` | **140px** | width of the left catch-zone where an open-drag may start |
| `THRESHOLD` | **0.40** | fraction of drawer width past which release commits to open/close |
| `VELOCITY` | **0.5 px/ms** | flick speed that commits regardless of distance |
| `SLOP` | **8px** | movement before the gesture locks to an axis |

## Mechanics

The drawer already animates between `-translate-x-full` (closed) and `translate-x-0`
(open) via a CSS transition. The gesture:

1. **Open drag** starts on `pointerdown` while closed and `startX <= EDGE`.
   **Close drag** starts on `pointerdown` while open (anywhere on drawer/scrim).
2. On first movement past `SLOP`, **lock the axis**: if the move is more vertical than
   horizontal, abandon the gesture so the page scrolls normally. Only a horizontal drag
   takes over (and calls `preventDefault` to stop the page scrolling).
3. While dragging: **disable the CSS transition** and set an inline `translateX` so the
   panel tracks the finger; fade the scrim opacity proportionally (0 → 0.4).
4. On `pointerup`: commit to open/closed if `progress` passed `THRESHOLD` **or** flick
   `velocity` exceeded the threshold (sign-aware). Re-enable the transition, clear the
   inline transform, and let the className snap to the final state.

## Architecture / units

- **`apps/web/lib/useDrawerGesture.ts`** (new) — owns the drag math. Inputs: `open`,
  `setOpen` (from `useDrawer()`), `isMobile`, and a ref to measure drawer width. Outputs:
  pointer handlers, `dragging` flag, `progress` (0–1). Pointer Events + guarded
  `setPointerCapture` (jsdom lacks it). Constants exported for testing.
- **`apps/web/components/ShellChrome.tsx`** (edit) — render a left **edge-catch strip**
  (mobile + closed only), wire the handlers, apply the live inline transform while
  dragging, and drive scrim opacity from `progress`. Keep the button-open path, scrim-tap
  and Escape exactly as they are.
- **`apps/web/components/personal/PersonalShell.tsx`** (edit) — bring its sidebar under
  the same `ShellChrome` drawer treatment so the gesture works in Personal space too.
  (Confirm its current structure during implementation; reuse `ShellChrome` rather than
  duplicating the gesture.)

## Edge cases

- Gated behind `isMobile` — **desktop completely unaffected** (no edge strip, gesture
  inert).
- Only the first pointer is tracked (ignore multi-touch).
- Navigation mid-drag: the existing pathname effect already closes the drawer; the
  gesture resets on `pointerup` regardless.
- Reduced motion: snap uses the existing ~200ms transition (functional, not decorative) —
  left as-is.

## Testing (TDD)

`useDrawerGesture.test.ts` + updates to `ShellChrome.test.tsx`, driving
`fireEvent.pointerDown/Move/Up` in jsdom:

- edge-drag past threshold → opens; short drag → stays closed
- drag starting **beyond** `EDGE` while closed → does **not** open
- vertical-dominant move → gesture bails, state unchanged
- flick (high velocity, short distance) → opens
- left-drag on open drawer past threshold → closes
- `isMobile === false` → edge strip not rendered, gesture inert

## Out-of-repo dev aid (not committed)

A no-login HTML prototype (`/tmp/swipe-lab/index.html`) served via a static server +
cloudflared tunnel was used to validate feel on a real device. It is intentionally not
part of the repo. The dev-only `next.config.mjs` `allowedDevOrigins` hack was reverted.
