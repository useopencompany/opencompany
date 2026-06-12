# Chat opens at bottom + stick-to-bottom + jump-to-bottom pill

**Date:** 2026-06-11
**Branch:** `chat-scroll-to-bottom`
**Component:** `apps/web/components/SessionView.tsx`

## Problem

When you open (or switch into) a chat/session, the message list renders scrolled to the
**top** (oldest message). You have to manually scroll to the bottom every time to see the
newest messages. Desired behavior is ChatGPT/Slack-like: open at the **bottom** (newest),
follow new content while you're at the bottom, and offer a one-click way back down when
you've scrolled up.

## Root cause

`SessionView.tsx` already has a deliberate, sophisticated scroll system — but it was built
entirely around the **send** flow, and the **open** flow was never wired up.

Existing pieces:

1. **Send-snap** (`SessionView.tsx:987`, `useLayoutEffect`): when the user sends a message,
   the just-sent message is pinned to the **top** of the viewport and the reply streams in
   below it (the modern ChatGPT pattern). Reserved space below comes from a CSS `min-height`
   on the last turn (`LAST_TURN_MIN_HEIGHT_FACTOR = 0.5` of `--chat-vh`). After the snap,
   `isPinnedAtBottomRef.current = false`. **Deliberate — must not break.**
2. **Streaming bottom-follow** (`:1010`, `useEffect`): while an assistant turn is running/waiting
   *and* the user is pinned at the bottom, scrolls to `scrollHeight` on each delta. This is
   effectively "Layer 2" and already works.
3. **Pin tracking** (`onScroll` at `:1363`): updates `isPinnedAtBottomRef` to
   `distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX` (80px) — but only on a *genuine* user
   wheel/touch scroll (gated by `userScrollIntentRef`, set in `markUserScrollIntent`).

**The bug:** there is **no effect that scrolls to the bottom when a chat is opened.** A fresh
`overflow-y-auto` container defaults to `scrollTop = 0` (top), and nothing corrects it. Both
existing scroll effects skip the open case:

- Send-snap only runs when `pendingScrollMessageId` is set → only on a send.
- Follow only runs when `hasRunningAssistantMessage || showWaitingForAssistant` → only during
  an active turn.

So opening an **idle/completed** session triggers neither effect → stuck at the top.

Latent defect: `isPinnedAtBottomRef` is initialized to `true` (`:447`) while the DOM is
actually at the top, so the ref does not reflect reality on open.

## Goals

- Opening / switching into any chat lands at the **bottom** (newest message), instantly, with
  no visible top→bottom jump (flash).
- While pinned at the bottom, new/streamed content keeps the view at the bottom (already works;
  verify against the new initial state).
- A floating **jump-to-bottom pill** lets the user return to the bottom in one click when they
  are scrolled up.
- The existing send-snap behavior (sent message pins to top, reply streams below) is unchanged.

## Non-goals (YAGNI)

- List virtualization (react-virtuoso / react-window). Messages stay flat in the DOM.
- A "N new messages" counter/badge on the pill — plain down-arrow only.
- Per-chat scroll-position memory (restoring an arbitrary mid-history scroll offset).
- Infinite-scroll / pagination of older messages (not currently present).

## Design

### Layer 1 — Open at bottom (the real fix)

A `useLayoutEffect` (runs before paint → no flash) keyed on `session.id`:

- Runs once per chat-open, after `visibleMessages` is populated (content height is known).
- Scrolls the container to `scrollHeight` instantly (`behavior: "auto"`).
- Sets pin-state to `true` **honestly** (we are now at the bottom).
- Guarded so it performs the initial snap only once per session id — not on every
  `visibleMessages` change (that is the follow's job), and not re-triggering the snap when the
  user later scrolls up.
- Does not conflict with the send-snap: different triggers (mount/session-change vs. send). If a
  send-snap is pending, Layer 1 yields to it (the send case already positions the view).

Edge cases:

- **Opening an actively-streaming session** (running turn, but the user did not send it from this
  mount): Layer 1 lands at the bottom, then the existing follow takes over → user sees live output.
- **Switching chats without unmount** (component reused, only `session.id` prop changes): keying the
  effect on `session.id` re-runs the initial snap for the newly-opened chat.

### Layer 2 — Stick-to-bottom follow (already exists)

No rewrite. Verify it engages correctly now that Layer 1 establishes an honest
"pinned at bottom" starting state. Expected: no change needed.

### Layer 3 — Jump-to-bottom pill

- A floating circular "↓" button near the bottom of the message area, above the composer
  (absolutely positioned within / over the scroll region, centered or bottom-right).
- **Visibility:** shown whenever the user is **not** pinned at the bottom **and** the container is
  scrollable (`scrollHeight > clientHeight`). This naturally covers both cases:
  (a) scrolled up to read history, and (b) after a send, while the reply streams below the fold.
- **Click:** smooth-scrolls to `scrollHeight` (`behavior: "smooth"`) and re-pins
  (`setPinnedAtBottom(true)`), so the follow re-engages.
- Styling follows existing OpenCompany tokens (canvas/ink/border vars, matching the app's
  existing floating controls). Accessible: real `<button>` with an `aria-label`.

### Required refactor — single source of truth for pin-state (root-cause, not a bolt-on)

Today pin-state lives only in `isPinnedAtBottomRef` (a ref). Refs don't trigger re-renders, but
the pill's visibility must react to pin-state changes. Introduce a single helper that keeps a
ref **and** a `useState` mirror in sync:

```ts
const isPinnedAtBottomRef = useRef(true);
const [isPinnedAtBottom, setIsPinnedAtBottomState] = useState(true);
const setPinnedAtBottom = (value: boolean) => {
  isPinnedAtBottomRef.current = value;
  setIsPinnedAtBottomState((prev) => (prev === value ? prev : value)); // only re-render on change
};
```

- Route **all four** mutation sites through `setPinnedAtBottom`: `onScroll` handler (`:1373`),
  send-snap (`:1002`, sets `false`), Layer 1 (sets `true`), and the pill click (sets `true`).
- The ref stays the hot-path read for the streaming follow (no behavior/perf change). The state
  only flips when the boolean actually changes, so there's no per-scroll re-render churn — the
  streaming-follow performance is preserved.

## Before/after demo video (deliverable)

The user wants a before/after video. **Ordering is critical** — the "before" (buggy) behavior must
be captured **before** any code changes, or it's lost.

1. **Before** — run the app locally on the current (unfixed) branch, open a chat with existing
   messages, and record it rendering at the top / needing a manual scroll. Save the clip.
2. Implement the fix.
3. **After** — record opening the same chat landing at the bottom, the follow during streaming,
   scrolling up to reveal the pill, and clicking the pill to jump back down.
4. Present before + after together; attach the "after" walkthrough to the PR (the `feature-video`
   skill can record + attach it).

Capture via local dev server + browser automation (claude-in-chrome or playwright). This is a
cross-environment handoff (browser QA) — set it up early in implementation, not at the end.

## Testing plan

- Open an **idle** chat → lands at the bottom (no manual scroll).
- Open a **long** chat → no visible top→bottom flash (before-paint snap).
- **Send** a message → still snaps the sent message to the top, reply streams below (unchanged).
- **Scroll up** during streaming → follow pauses; pill appears.
- **Click pill** → smooth-scrolls to bottom; follow resumes; pill hides.
- **Switch** between chats → each opens at the bottom.
- Pill is hidden when already at the bottom and when the chat is too short to scroll.

## Affected files

- `apps/web/components/SessionView.tsx` — Layer 1 effect, `setPinnedAtBottom` helper + rerouting
  the four mutation sites, pill JSX + visibility state.
- Possibly a small presentational subcomponent for the pill if it keeps `SessionView` readable.
