# Mobile / Phone UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OpenCompany web app stable, readable, and thumb-friendly on phones — fixing layout crush, the new-chat jump, accidental zoom, clipped composer, and the distracting Safari bar — without changing the desktop experience.

**Architecture:** All mobile behavior is gated behind the `md` (768px) breakpoint or a new `useIsMobile()` signal, so ≥ md is untouched. A thin client `ShellChrome` wrapper turns the existing in-flow sidebar into an off-canvas drawer on phones while the server `AppShell` stays server-rendered. Small, independent fixes (viewport/16px, dvh, PWA) ship separately from the larger drawer work.

**Tech Stack:** Next.js App Router (server + client components), React 19, Tailwind **v4** (CSS `@theme`, no config file; default breakpoints; `h-dvh` available), Vitest + jsdom + @testing-library/react, `cn` from `lib/utils.ts`.

## Global Constraints

- **Desktop (≥ md = 768px) must render byte-for-byte as today.** Every change is gated behind `md:` prefixes or `useIsMobile()`. Verify no desktop regression after each task.
- **Tailwind v4** — no `tailwind.config.*`; tokens live in `app/globals.css` `@theme`. Default breakpoints (`sm`640 `md`768 `lg`1024). `h-dvh`/`min-h-dvh` are available.
- **`cn` util:** `import { cn } from "@/lib/utils"`.
- **Tests:** Vitest (`environment: jsdom`, `globals: true`), `@testing-library/react` (`render`, `screen`), `@testing-library/user-event`. Run from `apps/web` with `bun run test` (vitest). Follow the provider-wrapping pattern in `components/Sidebar.test.tsx`.
- **Verify-before-fix:** each fix task reproduces its bug in the booted iOS Simulator (iPhone 17 Pro, UDID `4A4AA0CA-7195-4804-897B-D0D3634EA75B`, already logged in) before changing code, and re-verifies after.
- **Commits:** frequent, one per task. **Do NOT add `Co-Authored-By: Claude` or any AI co-author footer.** No PR until Jasper says so — the branch is `mobile-ui-fixes`.
- **Simulator screenshot:** `xcrun simctl io 4A4AA0CA-7195-4804-897B-D0D3634EA75B screenshot <path>.png`. Navigate via `xcrun simctl openurl <UDID> "https://my.opencompany.cloud/company"`. Coordinate taps via `idb ui tap <x> <y>` (points; screen is 402×874pt).

---

## Task 1: Baseline reproduction & screenshots (no code)

**Files:**
- Create: `.context/mobile-audit/baseline/` (screenshots)

**Goal:** Capture the current broken state so every later fix has a before/after.

- [ ] **Step 1: New-chat screen (sidebar-open crush)**

```bash
xcrun simctl openurl 4A4AA0CA-7195-4804-897B-D0D3634EA75B "https://my.opencompany.cloud/company"
sleep 4
xcrun simctl io 4A4AA0CA-7195-4804-897B-D0D3634EA75B screenshot .context/mobile-audit/baseline/01-new-chat.png
```

- [ ] **Step 2: Open sidebar, capture the crush** — tap the expand toggle (top-left, ~pt 16,28) then screenshot.

```bash
idb ui tap 16 28
sleep 1
xcrun simctl io 4A4AA0CA-7195-4804-897B-D0D3634EA75B screenshot .context/mobile-audit/baseline/02-sidebar-open-crush.png
```

- [ ] **Step 3: Session view + composer focus zoom** — open a session, tap the composer, screenshot the zoom.

```bash
# open most recent session from the sidebar, then:
xcrun simctl io 4A4AA0CA-7195-4804-897B-D0D3634EA75B screenshot .context/mobile-audit/baseline/03-session.png
# tap composer textarea (~pt 200,820) to trigger focus, then:
xcrun simctl io 4A4AA0CA-7195-4804-897B-D0D3634EA75B screenshot .context/mobile-audit/baseline/04-composer-zoom.png
```

- [ ] **Step 4: Confirm** each screenshot visibly shows its bug (crush = 1-char-per-line text; zoom = page enlarged after focus). These are the "FAIL" baselines. No commit (screenshots are gitignored under `.context`).

---

## Task 2: Stop accidental zoom — viewport export + 16px inputs

**Files:**
- Modify: `apps/web/app/layout.tsx` (add `viewport` export)
- Modify: `apps/web/components/MainPanel.tsx:185` (textarea font)
- Modify: `apps/web/components/SessionView.tsx:1758` (textarea font)
- Modify: `apps/web/components/Sidebar.tsx:528` (filter input font)
- Modify: `apps/web/app/globals.css` (text-size-adjust)
- Test: `apps/web/app/layout.viewport.test.ts` (new)

**Interfaces:**
- Produces: `export const viewport: Viewport` in `app/layout.tsx`.

- [ ] **Step 1: Write the failing test for the viewport export**

```ts
// apps/web/app/layout.viewport.test.ts
import { describe, expect, it, vi } from "vitest";

// layout.tsx imports WorkOS AuthKitProvider → transitively `next/cache`, which
// fails to resolve under vitest/jsdom. Mock the provider so we can import layout.
// (Reuse this mock pattern in any test that imports app/layout.tsx.)
vi.mock("@workos-inc/authkit-nextjs/components", () => ({
  AuthKitProvider: (props: { children?: unknown }) => props.children,
}));

import { viewport } from "./layout";

describe("root viewport", () => {
  it("locks scale to prevent iOS focus-zoom and covers safe areas", () => {
    expect(viewport.width).toBe("device-width");
    expect(viewport.initialScale).toBe(1);
    expect(viewport.maximumScale).toBe(1);
    expect(viewport.viewportFit).toBe("cover");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/web && bun run test layout.viewport`
Expected: FAIL — `viewport` is not exported from `./layout`.

- [ ] **Step 3: Add the viewport export to `app/layout.tsx`**

Change the import line:
```tsx
import type { Metadata, Viewport } from "next";
```
Add after the `metadata` export (after line 16):
```tsx
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f5" },
    { media: "(prefers-color-scheme: dark)", color: "#111111" },
  ],
};
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/web && bun run test layout.viewport`
Expected: PASS.

- [ ] **Step 5: Bump the three textareas/inputs to ≥16px on mobile**

`MainPanel.tsx:185` — change `text-[15px]` → `text-[16px] md:text-[15px]`:
```tsx
className="min-h-9 w-full resize-none content-center bg-transparent text-[16px] md:text-[15px] leading-6 tracking-[-0.005em] text-ink placeholder:text-ink-subtle outline-none"
```

`SessionView.tsx:1758` — change `text-[14px]` → `text-[16px] md:text-[14px]`:
```tsx
className="min-h-9 w-full resize-none content-center bg-transparent text-[16px] md:text-[14px] leading-5 text-ink outline-none placeholder:text-ink-subtle"
```

`Sidebar.tsx:528` — change `text-[12.5px]` → `text-[16px] md:text-[12.5px]`:
```tsx
className="h-7 w-full rounded-md border border-border bg-surface/55 pl-7 pr-7 text-[16px] md:text-[12.5px] text-ink outline-none placeholder:text-ink-subtle focus:border-border-strong focus:ring-2 focus:ring-ink/[0.04]"
```

- [ ] **Step 6: Add `text-size-adjust` guard to `globals.css`**

In the `html, body { … }` block (around line 135), add:
```css
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
```

- [ ] **Step 7: Verify in the simulator (visual — class assertions are too brittle to unit-test)**

```bash
xcrun simctl openurl 4A4AA0CA-7195-4804-897B-D0D3634EA75B "https://my.opencompany.cloud/company"
# tap the composer textarea, then screenshot:
xcrun simctl io 4A4AA0CA-7195-4804-897B-D0D3634EA75B screenshot .context/mobile-audit/after/02-no-zoom.png
```
Expected: focusing the composer does **not** enlarge the page (compare to `baseline/04-composer-zoom.png`).

- [ ] **Step 8: Verify no desktop regression** — load `my.opencompany.cloud/company` in a desktop browser at ≥768px; composer text size unchanged.

- [ ] **Step 9: Commit**

```bash
git add apps/web/app/layout.tsx apps/web/app/layout.viewport.test.ts apps/web/components/MainPanel.tsx apps/web/components/SessionView.tsx apps/web/components/Sidebar.tsx apps/web/app/globals.css
git commit -m "fix(mobile): stop iOS focus-zoom via viewport lock + 16px inputs"
```

---

## Task 3: Viewport-height stability — dvh

**Files:**
- Modify: `apps/web/components/AppShell.tsx:66`

**Interfaces:**
- Consumes: nothing. Produces: nothing new (CSS-only change).

- [ ] **Step 1: Reproduce the jump in the simulator** — open `/company`, scroll so the Safari address bar collapses/expands; capture `baseline/05-vh-jump.png`. (Document the reflow.)

- [ ] **Step 2: Swap `100vh`/`100vw` for dynamic units**

`AppShell.tsx:66` — change:
```tsx
<div className="flex h-screen w-screen overflow-hidden bg-canvas">
```
to:
```tsx
<div className="flex h-dvh w-full overflow-hidden overflow-x-hidden bg-canvas">
```
(`h-dvh` tracks the visible viewport as Safari's chrome shows/hides; `w-full` avoids `100vw` scrollbar overflow; `overflow-x-hidden` is the horizontal backstop.)

- [ ] **Step 3: Audit for other `h-screen`/`100vh` users**

Run: `cd apps/web && grep -rn "h-screen\|w-screen\|100vh\|100vw" components app`
Expected: no other shell-level offenders (the `var(--chat-vh, 100dvh)` in `SessionView` is already dvh — leave it). If any full-height container at the shell level remains, convert to `dvh` the same way and note it here.

- [ ] **Step 4: Verify in simulator** — scroll `/company` and a session; the layout no longer jumps as the address bar animates. Capture `after/05-no-vh-jump.png`.

- [ ] **Step 5: Verify no desktop regression** — `h-dvh` == `h-screen` on desktop (no browser-chrome animation); shell unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/AppShell.tsx
git commit -m "fix(mobile): use h-dvh so mobile browser chrome doesn't reflow the shell"
```

---

## Task 4: PWA standalone — manifest, Apple meta, icons (removes Safari's bar)

**Files:**
- Create: `apps/web/app/manifest.ts`
- Create: `apps/web/public/icons/icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `apple-touch-icon.png` (180px)
- Modify: `apps/web/app/layout.tsx` (Apple web-app metadata + apple-touch-icon)
- Test: `apps/web/app/manifest.test.ts` (new)

**Interfaces:**
- Produces: default-exported `manifest()` returning `MetadataRoute.Manifest`.

- [ ] **Step 1: Write the failing test for the manifest**

```ts
// apps/web/app/manifest.test.ts
import { describe, expect, it } from "vitest";
import manifest from "./manifest";

describe("web app manifest", () => {
  it("is a standalone installable PWA", () => {
    const m = manifest();
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    expect(m.name?.toLowerCase()).toContain("opencompany");
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect((m.icons ?? []).some((i) => i.purpose === "maskable")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/web && bun run test manifest`
Expected: FAIL — cannot find `./manifest`.

- [ ] **Step 3: Create `app/manifest.ts`**

```ts
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OpenCompany",
    short_name: "OpenCompany",
    description: "Company workspace for agents, inbox, and shared context.",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f7f5",
    theme_color: "#f7f7f5",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/web && bun run test manifest`
Expected: PASS.

- [ ] **Step 5: Generate the icon PNGs from the brand SVG**

Source SVG: `apps/web/public/brand/opencompany-icon-dark.svg` (referenced by layout). Use the **web-asset-generator skill** (purpose-built for PWA icons/favicons) to produce, into `apps/web/public/icons/`:
- `icon-192.png` (192×192), `icon-512.png` (512×512)
- `icon-512-maskable.png` (512×512, ~12% safe-area padding, solid `#f7f7f5` background)
- `apple-touch-icon.png` (180×180, solid background — iOS ignores transparency)

(If the skill is unavailable, run `bunx sharp-cli -i public/brand/opencompany-icon-dark.svg -o public/icons/icon-512.png resize 512 512` etc., adding a flatten step for the apple-touch and maskable variants.)

Verify: `ls -la apps/web/public/icons/` shows all four non-zero PNGs.

- [ ] **Step 6: Add Apple web-app metadata to `app/layout.tsx`**

In the `metadata` object, add `appleWebApp` and the apple-touch icon:
```tsx
export const metadata: Metadata = {
  title: isLocalDev ? "opencompany (local)" : "opencompany",
  description: "Company workspace for agents, inbox, and shared context.",
  appleWebApp: {
    capable: true,
    title: "OpenCompany",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};
```

- [ ] **Step 7: Verify install (real device — simulator can't Add-to-Home-Screen reliably)**

Hand off to Jasper: on his iPhone, open `my.opencompany.cloud` → Share → **Add to Home Screen** → open from the icon. Expected: **full-screen, no address bar, no bottom toolbar.** Confirm the home-screen icon is the brand icon, not a screenshot.

- [ ] **Step 8: Verify no desktop regression** — desktop unaffected (manifest/apple-meta are no-ops on desktop browsers).

- [ ] **Step 9: Commit**

```bash
git add apps/web/app/manifest.ts apps/web/app/manifest.test.ts apps/web/app/layout.tsx apps/web/public/icons/
git commit -m "feat(mobile): installable standalone PWA (manifest + apple meta + icons)"
```

---

## Task 5: Mobile shell scaffolding — `useIsMobile` hook + `ShellChrome` client wrapper

**Files:**
- Create: `apps/web/lib/useIsMobile.ts`
- Create: `apps/web/lib/useIsMobile.test.ts`
- Create: `apps/web/components/ShellChrome.tsx`
- Create: `apps/web/components/ShellChrome.test.tsx`
- Modify: `apps/web/components/AppShell.tsx` (wrap sidebar + children in `ShellChrome`)

**Interfaces:**
- Produces: `useIsMobile(): boolean` (true when viewport < 768px).
- Produces: `<ShellChrome sidebar={ReactNode}>{children}</ShellChrome>` — client component owning drawer-open state; renders desktop layout unchanged at ≥ md and an off-canvas drawer + scrim below md.
- Consumes (Task 6): an exported `useDrawer()` context hook `{ open: boolean; setOpen: (v: boolean) => void }` from `ShellChrome.tsx`.

- [ ] **Step 1: Write the failing test for `useIsMobile`**

```ts
// apps/web/lib/useIsMobile.test.ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsMobile } from "./useIsMobile";

function mockMatchMedia(matches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    dispatchEvent: () => true,
  }));
  return { fire: (m: boolean) => listeners.forEach((cb) => cb({ matches: m } as MediaQueryListEvent)) };
}

afterEach(() => vi.unstubAllGlobals());

describe("useIsMobile", () => {
  it("returns true below the md breakpoint", () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });
  it("updates when the media query changes", () => {
    const mm = mockMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
    act(() => mm.fire(true));
    expect(result.current).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/web && bun run test useIsMobile`
Expected: FAIL — cannot find `./useIsMobile`.

- [ ] **Step 3: Implement `lib/useIsMobile.ts`**

```ts
"use client";

import { useEffect, useState } from "react";

const MOBILE_QUERY = "(max-width: 767px)"; // below Tailwind `md`

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);
  return isMobile;
}
```
(Starts `false` so SSR/first paint matches desktop; corrects on mount — acceptable because mobile styling is also driven by CSS `md:` classes that don't depend on JS.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/web && bun run test useIsMobile`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `ShellChrome`**

```tsx
// apps/web/components/ShellChrome.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellChrome } from "./ShellChrome";

afterEach(() => vi.unstubAllGlobals());

function setMobile(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => true,
  }));
}

describe("ShellChrome", () => {
  it("renders sidebar and content", () => {
    setMobile(false);
    render(<ShellChrome sidebar={<nav>SIDEBAR</nav>}><div>CONTENT</div></ShellChrome>);
    expect(screen.getByText("SIDEBAR")).toBeInTheDocument();
    expect(screen.getByText("CONTENT")).toBeInTheDocument();
  });

  it("on mobile, shows a scrim when the drawer opens and hides it on scrim click", async () => {
    setMobile(true);
    const user = userEvent.setup();
    render(
      <ShellChrome sidebar={<nav>SIDEBAR</nav>}>
        <DrawerOpener />
      </ShellChrome>,
    );
    expect(screen.queryByTestId("drawer-scrim")).toBeNull();
    await user.click(screen.getByRole("button", { name: "open" }));
    const scrim = screen.getByTestId("drawer-scrim");
    expect(scrim).toBeInTheDocument();
    await user.click(scrim);
    expect(screen.queryByTestId("drawer-scrim")).toBeNull();
  });
});

// Minimal consumer that toggles the drawer via the exported context hook.
import { useDrawer } from "./ShellChrome";
function DrawerOpener() {
  const { setOpen } = useDrawer();
  return <button type="button" onClick={() => setOpen(true)}>open</button>;
}
```

- [ ] **Step 6: Run it, verify it fails**

Run: `cd apps/web && bun run test ShellChrome`
Expected: FAIL — cannot find `./ShellChrome`.

- [ ] **Step 7: Implement `components/ShellChrome.tsx`**

```tsx
"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/lib/useIsMobile";

type DrawerContext = { open: boolean; setOpen: (v: boolean) => void; isMobile: boolean };
const Ctx = createContext<DrawerContext | null>(null);

export function useDrawer(): DrawerContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDrawer must be used within ShellChrome");
  return ctx;
}

export function ShellChrome({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer on navigation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setOpen(false); }, [pathname]);

  // Lock body scroll + close on Escape while the drawer is open on mobile.
  useEffect(() => {
    if (!(isMobile && open)) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [isMobile, open]);

  return (
    <Ctx.Provider value={{ open, setOpen, isMobile }}>
      {/* Desktop: in-flow sidebar (unchanged). Mobile: off-canvas drawer. */}
      <div
        className={cn(
          "shrink-0",
          isMobile &&
            "fixed inset-y-0 left-0 z-40 transition-transform duration-200 ease-out",
          isMobile && (open ? "translate-x-0" : "-translate-x-full"),
        )}
      >
        {sidebar}
      </div>

      {isMobile && open ? (
        <button
          type="button"
          aria-label="Close menu"
          data-testid="drawer-scrim"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-black/40"
        />
      ) : null}

      {children}
    </Ctx.Provider>
  );
}
```

- [ ] **Step 8: Run the ShellChrome test, verify it passes**

Run: `cd apps/web && bun run test ShellChrome`
Expected: PASS (both cases).

- [ ] **Step 9: Wire `ShellChrome` into `AppShell.tsx`**

Replace the shell body (lines 66-88) so the sidebar + children are passed to `ShellChrome`. Add `import { ShellChrome } from "@/components/ShellChrome";` at the top. New body:
```tsx
<div className="flex h-dvh w-full overflow-hidden overflow-x-hidden bg-canvas">
  <ShellChrome
    sidebar={
      <Suspense
        fallback={
          <Sidebar
            userName={userName}
            userEmail={authUser.email}
            workspaceName={workspace.name}
            initialCollapsed={initialSidebarCollapsed}
            initialSessions={[]}
            sessionsLoading
          />
        }
      >
        <SidebarWithSessions
          userName={userName}
          userEmail={authUser.email}
          workspaceName={workspace.name}
          initialCollapsed={initialSidebarCollapsed}
          sessionsPromise={sessionsPromise}
        />
      </Suspense>
    }
  >
    {children}
  </ShellChrome>
</div>
```
(Server `Suspense`/`Sidebar` are passed as the `sidebar` prop — a client component may receive server-rendered nodes as props.)

- [ ] **Step 10: Verify desktop unchanged + tests green**

Run: `cd apps/web && bun run test ShellChrome useIsMobile && bun run lint`
Load desktop ≥768px: sidebar still in-flow, no scrim, identical to before (on desktop `isMobile===false` → no fixed positioning).

- [ ] **Step 11: Commit**

```bash
git add apps/web/lib/useIsMobile.ts apps/web/lib/useIsMobile.test.ts apps/web/components/ShellChrome.tsx apps/web/components/ShellChrome.test.tsx apps/web/components/AppShell.tsx
git commit -m "feat(mobile): add useIsMobile + ShellChrome drawer wrapper (desktop unchanged)"
```

---

## Task 6: Drawer wiring — full-width content, thumb-reachable toggle, close behaviors (keep sidebar search visible)

**Files:**
- Modify: `apps/web/components/Sidebar.tsx` (drawer-aware toggle; hide filter on mobile)
- Create: `apps/web/components/MobileMenuButton.tsx` (thumb-reachable open button)
- Create: `apps/web/components/MobileMenuButton.test.tsx`
- Modify: `apps/web/components/AppShell.tsx` (mount `MobileMenuButton` inside `ShellChrome`)

**Interfaces:**
- Consumes: `useDrawer()` from `ShellChrome.tsx` (Task 5).

- [ ] **Step 1: Reproduce the crush with the new drawer** — after Task 5, on mobile the sidebar is off-canvas but there's no open button yet and content may not be full-width. Capture `baseline/06-predrawer.png` for reference.

- [ ] **Step 2: Write the failing test for `MobileMenuButton`**

```tsx
// apps/web/components/MobileMenuButton.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellChrome, useDrawer } from "./ShellChrome";
import { MobileMenuButton } from "./MobileMenuButton";

afterEach(() => vi.unstubAllGlobals());
function setMobile() {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => true }));
}

it("opens the drawer when tapped", async () => {
  setMobile();
  const user = userEvent.setup();
  render(<ShellChrome sidebar={<nav>SIDEBAR</nav>}><MobileMenuButton /></ShellChrome>);
  expect(screen.queryByTestId("drawer-scrim")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Open menu" }));
  expect(screen.getByTestId("drawer-scrim")).toBeInTheDocument();
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `cd apps/web && bun run test MobileMenuButton`
Expected: FAIL — cannot find `./MobileMenuButton`.

- [ ] **Step 4: Implement `components/MobileMenuButton.tsx` (bottom-left, thumb-reachable, mobile-only)**

```tsx
"use client";

import { PanelLeft } from "lucide-react";
import { useDrawer } from "@/components/ShellChrome";

export function MobileMenuButton() {
  const { isMobile, open, setOpen } = useDrawer();
  if (!isMobile || open) return null;
  return (
    <button
      type="button"
      aria-label="Open menu"
      onClick={() => setOpen(true)}
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+1rem)] left-4 z-20 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-canvas/90 text-ink shadow-[0_2px_8px_rgba(15,15,15,0.12)] backdrop-blur-md"
    >
      <PanelLeft size={18} strokeWidth={1.75} />
    </button>
  );
}
```
(44px target, bottom-left within thumb reach, respects the home-indicator safe area. Hidden on desktop and while the drawer is open.)

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd apps/web && bun run test MobileMenuButton`
Expected: PASS.

- [ ] **Step 6: Mount the button inside `ShellChrome` via `AppShell`** — add `import { MobileMenuButton } from "@/components/MobileMenuButton";` and render `<MobileMenuButton />` just before `{children}` inside `ShellChrome`:
```tsx
    <MobileMenuButton />
    {children}
```

- [ ] **Step 7: Make the off-canvas sidebar full-height + give content full width on mobile**

In `Sidebar.tsx` the `<aside>` (line 461) collapses via `w-0`/`w-[256px]`. Inside the mobile drawer it must always be full 256px (the drawer container handles show/hide via translate, not width). Gate the width-collapse to desktop only:
```tsx
className={`relative h-full shrink-0 overflow-hidden bg-sidebar transition-[width] duration-200 ease-out ${
  collapsed ? "md:w-0 w-[256px]" : "w-[256px]"
}`}
```
(On mobile, `w-[256px]` always; the `ShellChrome` translate shows/hides it. On desktop, the existing `collapsed` width behavior is preserved via `md:w-0`.)

- [ ] **Step 8: Keep the in-app session filter on mobile (per Jasper) — verify it's usable**

Do NOT hide the filter — it stays available on phones. The 16px font bump from Task 2 (`Sidebar.tsx:528`) already prevents focus-zoom on it. Verify on the simulator: open the filter, focus the input → no page zoom, and it doesn't overflow the drawer width.

- [ ] **Step 9: Close the drawer when a sidebar nav item is tapped**

`ShellChrome` already closes on `pathname` change (Task 5, Step 7), which covers nav-link taps (they navigate). No extra wiring needed; confirm by test/observation. (Document: links that don't change the path won't auto-close — acceptable.)

- [ ] **Step 10: Verify the full drawer flow in the simulator**

```bash
xcrun simctl openurl 4A4AA0CA-7195-4804-897B-D0D3634EA75B "https://my.opencompany.cloud/company"
sleep 4
xcrun simctl io 4A4AA0CA-7195-4804-897B-D0D3634EA75B screenshot .context/mobile-audit/after/06-content-fullwidth.png
idb ui tap 32 800   # bottom-left menu button
sleep 1
xcrun simctl io 4A4AA0CA-7195-4804-897B-D0D3634EA75B screenshot .context/mobile-audit/after/07-drawer-open.png
# tap scrim area (right side) to close:
idb ui tap 360 400
sleep 1
xcrun simctl io 4A4AA0CA-7195-4804-897B-D0D3634EA75B screenshot .context/mobile-audit/after/08-drawer-closed.png
```
Expected: content is **full-width with no 1-char-per-line crush**; menu button opens the drawer over a scrim; tapping the scrim/navigating closes it; composer send button is **no longer clipped**.

- [ ] **Step 11: Verify no desktop regression**

Run: `cd apps/web && bun run test && bun run lint`
Desktop ≥768px: sidebar in-flow, collapse toggle works as before, filter visible, no menu button, no scrim.

- [ ] **Step 12: Commit**

```bash
git add apps/web/components/Sidebar.tsx apps/web/components/MobileMenuButton.tsx apps/web/components/MobileMenuButton.test.tsx apps/web/components/AppShell.tsx
git commit -m "feat(mobile): off-canvas drawer with thumb-reachable toggle; full-width content; hide filter on mobile"
```

---

## Task 7: Final QA sweep (simulator + real device)

**Files:** none (verification only)

- [ ] **Step 1: Re-run the full bug list on the simulator** at portrait + landscape, comparing `after/` vs `baseline/`: (1) no crush, (2) no new-chat jump, (3) hero centered, (4) no focus-zoom, (5) composer button not clipped, (6) drawer works.

- [ ] **Step 2: Desktop regression pass** — `bun run test && bun run lint && bun run build` from `apps/web`; load desktop and click through sidebar collapse, a session, settings — identical to pre-change.

- [ ] **Step 3: Real-device pass (Jasper)** — Add-to-Home-Screen PWA: full-screen (no Safari bar), no accidental zoom, drawer reachable one-handed.

- [ ] **Step 4: Summarize** results in `.context/mobile-audit/RESULTS.md` (before/after screenshots + pass/fail per bug). Stop here — **no PR** until Jasper says so.

---

## Self-Review notes

- **Spec coverage:** responsive shell/drawer → Tasks 5–6; dvh → Task 3; stable centering → mostly resolved by full-width content (Task 6) + dvh (Task 3) — note the hero(`MainPanel`)→session(`SessionView`) transition is two routes, so perfect continuity is out of scope; 16px + viewport → Task 2; horizontal-overflow guard → Tasks 3 & 5 (`overflow-x-hidden`); PWA → Task 4; sidebar search on mobile → kept visible (Jasper; zoom handled by Task 2); thumb-reachable control → Task 6.
- **Open question deferrals:** in-app search kept visible on mobile (per Jasper); status bar `black-translucent` (default chosen). Easy to flip.
- **Risk:** Task 6 Step 7 is the one Sidebar class edit that affects both modes — the `md:w-0` gate keeps desktop behavior; verify desktop collapse explicitly.
