# Chat Scroll-to-Bottom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening/switching into a chat lands at the newest message (bottom), keeps following while pinned at the bottom, and shows a one-click "jump to bottom" pill when scrolled up.

**Architecture:** Three layers in `apps/web/components/SessionView.tsx`. (1) A `useLayoutEffect` keyed on `session.id` snaps the scroll container to the bottom once per chat-open, before paint. (2) The existing streaming bottom-follow (`SessionView.tsx:1010`) is unchanged. (3) A floating jump-to-bottom pill, driven by a `useState` mirror of the pin-state ref so its visibility can re-render. A single `setPinnedAtBottom()` helper becomes the one source of truth for pin-state, replacing the four scattered `isPinnedAtBottomRef.current = …` writes.

**Tech Stack:** Next.js 16 / React 19, TypeScript, Tailwind v4, lucide-react icons, Vitest + Testing Library (jsdom), bun@1.3.2.

**Spec:** `docs/superpowers/specs/2026-06-11-chat-scroll-to-bottom-design.md`

---

## File Structure

- **Modify** `apps/web/components/SessionView.tsx`
  - Add `ArrowDown` to the lucide-react import (block at lines 16–38; `ArrowUp` already there).
  - Add `isPinnedAtBottom` state + `setPinnedAtBottom()` helper next to `isPinnedAtBottomRef` (`:447`).
  - Reroute the existing pin-state writes (`:1002` send-snap, `:1373` onScroll) through `setPinnedAtBottom()`.
  - Add the Layer 1 "open at bottom" `useLayoutEffect` (near the other scroll effects, after `:1025`).
  - Add a `scrollToBottom()` helper and the pill JSX (wrap the scroll container at `:1358`).
- **Modify** `apps/web/components/SessionView.test.tsx`
  - New `describe` block for open-at-bottom + pill, mirroring the existing PRO-124 jsdom scroll stubs (`:1300`).
- **No new files.** The pill is small enough to live inline; extract only if `SessionView` readability suffers (judgment call during Task 3).

**Branch:** `chat-scroll-to-bottom` (already checked out — confirm with `git branch --show-current`).

**Commit policy:** No `Co-Authored-By` footer in any commit (user rule).

---

## Task 0: Capture the "before" video (MUST run before any code change)

The buggy behavior disappears the moment Layer 1 lands. Capture it first.

**Files:** none (manual / browser QA).

- [ ] **Step 1: Start the web dev server**

Run: `bun run dev:web`
Expected: Next.js dev server boots, prints a local URL (typically `http://localhost:3000`). Leave it running.

- [ ] **Step 2: Record the bug**

Open a workspace, click into a session/chat that already has several messages. Record (screen capture or the `claude-in-chrome` gif_creator) the chat rendering scrolled to the **top**, requiring a manual scroll to reach the newest message. Save as `before-chat-scroll.mov`/`.gif` in `.context/`.

- [ ] **Step 3: Confirm with the user**

This is the first checkpoint. Show the "before" clip and confirm it captures the bug before proceeding to code. Do not start Task 1 until confirmed.

---

## Task 1: Single source of truth for pin-state (behavior-preserving refactor)

Today pin-state lives only in `isPinnedAtBottomRef` (a ref, no re-render). The pill (Task 3) needs a reactive value. Introduce a state mirror + helper and route all existing writes through it. This task must not change any behavior — the existing snap-to-top tests are the regression guard.

**Files:**
- Modify: `apps/web/components/SessionView.tsx:447` (ref decl), `:1002` (send-snap write), `:1373` (onScroll write)

- [ ] **Step 1: Establish a green baseline**

Run: `cd apps/web && bun run test SessionView`
Expected: PASS (existing `PRO-124: snap user message to top on send` suite is green). Record the pass count.

- [ ] **Step 2: Add the state mirror + helper**

In `SessionView.tsx`, find (around `:445`):

```ts
  // Whether the user is "pinned" at the bottom of the scroll container. Drives the
  // streaming bottom-follow.
  const isPinnedAtBottomRef = useRef(true);
```

Replace with:

```ts
  // Whether the user is "pinned" at the bottom of the scroll container. Drives the
  // streaming bottom-follow (hot-path read, via the ref) AND the jump-to-bottom pill's
  // visibility (needs a re-render, via the state mirror). `setPinnedAtBottom` is the
  // single writer that keeps the two in sync; it only re-renders when the boolean
  // actually flips, so per-scroll churn stays off the streaming follow.
  const isPinnedAtBottomRef = useRef(true);
  const [isPinnedAtBottom, setIsPinnedAtBottomState] = useState(true);
  const setPinnedAtBottom = (value: boolean) => {
    isPinnedAtBottomRef.current = value;
    setIsPinnedAtBottomState((prev) => (prev === value ? prev : value));
  };
```

- [ ] **Step 3: Reroute the send-snap write**

In the one-shot snap `useLayoutEffect` (around `:1000`), find:

```ts
    // The user is now reading from the top, not pinned at the bottom — the streaming
    // follow stays off until they scroll back down themselves.
    isPinnedAtBottomRef.current = false;
    setPendingScrollMessageId(null);
```

Replace the assignment line:

```ts
    // The user is now reading from the top, not pinned at the bottom — the streaming
    // follow stays off until they scroll back down themselves.
    setPinnedAtBottom(false);
    setPendingScrollMessageId(null);
```

- [ ] **Step 4: Reroute the onScroll write**

In the scroll container's `onScroll` handler (around `:1373`), find:

```ts
            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            isPinnedAtBottomRef.current = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX;
```

Replace the assignment line:

```ts
            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            setPinnedAtBottom(distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX);
```

- [ ] **Step 5: Verify no behavior change**

Run: `cd apps/web && bun run test SessionView`
Expected: PASS — same count as Step 1. The refactor is behavior-neutral.

Run: `cd apps/web && bun run typecheck`
Expected: PASS (no type errors; `isPinnedAtBottom` is currently unused — that's fine, Task 3 consumes it. If the linter errors on unused, proceed to Task 3 in the same commit, or prefix usage there. Do NOT silence with a disable comment.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/SessionView.tsx
git commit -m "Pin-state single source of truth in SessionView scroll"
```

> **CHECKPOINT (user rule — first real code task):** Pause here. Let the user run the app + tests and commit/confirm before continuing to Task 2. Ask whether to resume autopilot or continue with manual checkpoints.

---

## Task 2: Layer 1 — open chat at the bottom

**Files:**
- Modify: `apps/web/components/SessionView.tsx` (new `useLayoutEffect`, near `:1025`)
- Test: `apps/web/components/SessionView.test.tsx` (new describe block)

- [ ] **Step 1: Write the failing test**

Append to `apps/web/components/SessionView.test.tsx`. Mirror the PRO-124 jsdom stubs.

```tsx
// ── Open chat scrolled to the bottom ────────────────────────────────────────
describe("SessionViewContent — opens a chat scrolled to the bottom", () => {
  let scrollToSpy: ReturnType<typeof vi.fn>;
  let originalScrollTo: PropertyDescriptor | undefined;

  beforeEach(() => {
    scrollToSpy = vi.fn();
    originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value: scrollToSpy,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 2000, // taller than the viewport so "bottom" (2000) ≠ "top" (0)
    });
  });

  afterEach(() => {
    if (originalScrollTo) {
      Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
    } else {
      // biome-ignore lint/performance/noDelete: restore prototype to pre-test state
      delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
    }
    // biome-ignore lint/performance/noDelete: restore prototype to pre-test state
    delete (HTMLElement.prototype as unknown as { clientHeight?: unknown }).clientHeight;
    // biome-ignore lint/performance/noDelete: restore prototype to pre-test state
    delete (HTMLElement.prototype as unknown as { scrollHeight?: unknown }).scrollHeight;
    vi.clearAllMocks();
  });

  it("snaps an idle session with existing messages to the bottom on open", async () => {
    const detail = makeDetail({
      messages: [
        { id: "m_user", role: "user", content: "Question", status: "completed" },
        { id: "m_assistant", role: "assistant", content: "Answer", status: "completed" },
      ],
    });
    streamMock.status = "live";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    // Layer 1 issued an instant scroll toward the bottom (scrollHeight 2000).
    await waitFor(() => {
      const wentToBottom = scrollToSpy.mock.calls.some(
        ([arg]) => arg?.behavior === "auto" && (arg?.top ?? 0) >= 800,
      );
      expect(wentToBottom).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bun run test SessionView -t "snaps an idle session"`
Expected: FAIL — `wentToBottom` is `false` (no effect scrolls to the bottom on open today).

- [ ] **Step 3: Implement Layer 1**

In `SessionView.tsx`, immediately after the streaming bottom-follow `useEffect` (ends around `:1025`), add:

```ts
  // Open at bottom: when a chat is first opened (or switched to), land on the newest
  // message — once per session. Runs in useLayoutEffect (before paint) so there is no
  // visible top→bottom jump. Keyed on session.id and guarded by a ref so it never
  // re-fires on later message/stream renders (the streaming follow owns those) and
  // never fights the send-snap (which positions the view itself on send).
  const initialScrollSessionRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (pendingScrollMessageId) return; // a send-snap owns this frame
    if (initialScrollSessionRef.current === session.id) return; // already snapped this chat
    if (visibleMessages.length === 0) return; // wait until content exists
    const container = scrollContainerRef.current;
    if (!container || typeof container.scrollTo !== "function") return;
    container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    setPinnedAtBottom(true);
    initialScrollSessionRef.current = session.id;
  }, [session.id, visibleMessages, pendingScrollMessageId]);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && bun run test SessionView -t "snaps an idle session"`
Expected: PASS.

- [ ] **Step 5: Run the full SessionView suite (regression)**

Run: `cd apps/web && bun run test SessionView`
Expected: PASS — including the PRO-124 snap-to-top suite. (Layer 1 runs once on mount and is cleared from the spy before those assertions; keyed on `session.id` it does not re-fire on the streaming rerender.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/SessionView.tsx apps/web/components/SessionView.test.tsx
git commit -m "Open chat scrolled to the newest message"
```

---

## Task 3: Layer 3 — jump-to-bottom pill

**Files:**
- Modify: `apps/web/components/SessionView.tsx` (import, `scrollToBottom()` helper, wrapper + pill JSX)
- Test: `apps/web/components/SessionView.test.tsx` (extend the new describe block)

- [ ] **Step 1: Write the failing test**

Add inside the `describe("SessionViewContent — opens a chat scrolled to the bottom", …)` block from Task 2:

```tsx
  it("hides the pill at the bottom, shows it after scrolling up, and jumps back on click", async () => {
    const detail = makeDetail({
      messages: [
        { id: "m_user", role: "user", content: "Question", status: "completed" },
        { id: "m_assistant", role: "assistant", content: "Answer", status: "completed" },
      ],
    });
    streamMock.status = "live";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <SessionViewContent detail={detail} workspaceId="wks_test" />
      </QueryClientProvider>,
    );

    // Pinned at the bottom on open → no pill.
    expect(screen.queryByRole("button", { name: "Scroll to bottom" })).toBeNull();

    // Simulate a genuine user scroll UP: wheel flags intent, scroll re-measures.
    const scroller = view.container.querySelector(".overflow-y-auto") as HTMLElement;
    scroller.scrollTop = 0; // distanceFromBottom = 2000 - 0 - 800 = 1200 > 80 (threshold)
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);

    const pill = await screen.findByRole("button", { name: "Scroll to bottom" });

    scrollToSpy.mockClear();
    fireEvent.click(pill);

    // Clicking the pill smooth-scrolls to the bottom.
    expect(scrollToSpy).toHaveBeenCalledWith(
      expect.objectContaining({ top: 2000, behavior: "smooth" }),
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bun run test SessionView -t "hides the pill"`
Expected: FAIL — `findByRole("button", { name: "Scroll to bottom" })` times out (pill does not exist yet).

- [ ] **Step 3: Add the `ArrowDown` import**

In the lucide-react import block (`:16`–`:38`), add `ArrowDown` (keep the existing order — it sits just before `ArrowUp`):

```ts
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Bot,
```

- [ ] **Step 4: Add the `scrollToBottom` helper**

Place it next to the `setPinnedAtBottom` helper (after the Layer 1 effect is fine too). Add:

```ts
  // Jump-to-bottom pill action: smooth-scroll to the newest message and re-pin so the
  // streaming follow re-engages.
  const scrollToBottom = () => {
    const container = scrollContainerRef.current;
    if (!container || typeof container.scrollTo !== "function") return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    setPinnedAtBottom(true);
  };
```

- [ ] **Step 5: Wrap the scroll container and add the pill**

Find the scroll container opening (`:1358`) and its matching close (`:1468`, the `</div>` right before the composer comment block). Wrap them in a positioned flex column and add the pill as a sibling of the scroll container (so it pins to the scroll area's viewport, just above the composer, instead of scrolling with content).

Change the opening from:

```tsx
        <div
          ref={scrollContainerRef}
          className="relative flex-1 overflow-y-auto overscroll-contain [overflow-anchor:auto] px-6 py-6"
```

to (insert a wrapper line before it, and keep the scroll container as a child — its classes are unchanged):

```tsx
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollContainerRef}
            className="relative flex-1 overflow-y-auto overscroll-contain [overflow-anchor:auto] px-6 py-6"
```

Then find the scroll container's closing `</div>` at `:1468` (the one immediately before the `{/* While the agent awaits … */}` comment) and replace it with the pill + the wrapper close:

```tsx
          </div>
          {!isPinnedAtBottom ? (
            <button
              type="button"
              aria-label="Scroll to bottom"
              onClick={scrollToBottom}
              className="absolute bottom-4 left-1/2 z-20 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-canvas/90 text-ink shadow-md backdrop-blur transition hover:bg-surface"
            >
              <ArrowDown size={16} strokeWidth={2} />
            </button>
          ) : null}
        </div>
```

> Indentation note: the inner scroll container and its children gain one level of nesting. Match surrounding style; the linter/formatter (Step 7) will normalize. Verify the JSX still balances — one wrapper `<div>` opened, one extra `</div>` added at the close.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/web && bun run test SessionView -t "hides the pill"`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint, full suite**

Run: `cd apps/web && bun run typecheck`
Expected: PASS (`isPinnedAtBottom` is now consumed by the pill).

Run: `cd apps/web && bun run lint`
Expected: PASS (or auto-fixable formatting only — run `bun run lint:fix` if needed, then re-run).

Run: `cd apps/web && bun run test SessionView`
Expected: PASS — all SessionView suites, including PRO-124 and both new tests.

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/SessionView.tsx apps/web/components/SessionView.test.tsx
git commit -m "Add jump-to-bottom pill to chat"
```

---

## Task 4: Manual verification + "after" video

The unit tests cover the logic; the felt behavior is proven in the real app. This is the deliverable the user asked for.

**Files:** none (browser QA + PR).

- [ ] **Step 1: Run the app**

Run: `bun run dev:web` (if not already running from Task 0).

- [ ] **Step 2: Walk the spec's testing plan**

Verify each, recording as the "after" clip (`.context/after-chat-scroll.*`):
- Open an **idle** chat → lands at the bottom, no manual scroll.
- Open a **long** chat → no top→bottom flash.
- **Send** a message → still snaps the sent message to the top, reply streams below (unchanged).
- **Scroll up** during streaming → follow pauses; the "↓" pill appears.
- **Click the pill** → smooth-scrolls to the bottom; pill hides; follow resumes.
- **Switch** between chats → each opens at the bottom.
- Pill is hidden when at the bottom and when the chat is too short to scroll.

- [ ] **Step 3: Present before + after to the user**

Show both clips side by side. This is the proof the bug is fixed.

- [ ] **Step 4: Open the PR with the video**

Use the `compound-engineering:feature-video` skill to attach the "after" walkthrough to the PR description. PR opens against `main` with the `preview` label (user default). No `Co-Authored-By` footer.

---

## Self-Review (completed)

- **Spec coverage:** Layer 1 → Task 2. Layer 2 (existing follow) → verified in Task 2 Step 5 + Task 4. Layer 3 pill → Task 3. Single-source-of-truth refactor → Task 1. Before/after video → Task 0 + Task 4. All spec sections mapped.
- **Placeholders:** none — every code step shows the exact code; every command shows expected output.
- **Type/name consistency:** `setPinnedAtBottom`, `isPinnedAtBottom`, `isPinnedAtBottomRef`, `initialScrollSessionRef`, `scrollToBottom`, aria-label `"Scroll to bottom"` are used identically across the refactor, Layer 1, the pill, and the tests.
- **Ordering risk:** Task 0 (before video) is explicitly gated before Task 1, since the bug is unobservable after Layer 1 lands.
