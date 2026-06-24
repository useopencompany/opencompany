"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMobileInspector } from "@/components/MobileInspectorContext";
import { useDrawerGesture } from "@/lib/useDrawerGesture";
import { useIsMobile } from "@/lib/useIsMobile";
import { cn } from "@/lib/utils";

type DrawerContext = { open: boolean; setOpen: (v: boolean) => void; isMobile: boolean };

const Ctx = createContext<DrawerContext | null>(null);

export function useDrawer(): DrawerContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDrawer must be used within ShellChrome");
  return ctx;
}

/**
 * Responsive shell. At >= md the sidebar stays in-flow (desktop, unchanged). Below
 * md it becomes an off-canvas drawer over a scrim, and the content takes full width.
 *
 * Mobile swipe (see useDrawerGesture): edge-swipe opens the LEFT nav drawer (rendered
 * here) or, when a session page has registered one via MobileInspectorContext, the
 * RIGHT panel — whose live drag is forwarded back to that page so it tracks the finger.
 */
export function ShellChrome({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const drawerRef = useRef<HTMLDivElement>(null);
  const { handle } = useMobileInspector();

  const leftConfig = useMemo(
    () => ({
      isOpen: () => open,
      setOpen,
      getWidth: () => drawerRef.current?.getBoundingClientRect().width || 300,
    }),
    [open],
  );
  const rightConfig = useMemo(
    () =>
      handle ? { isOpen: handle.isOpen, setOpen: handle.setOpen, getWidth: handle.getWidth } : null,
    [handle],
  );

  // The Memory (Brain) page owns the left-edge swipe for its own file-tree drawer, so the
  // shell yields its nav-drawer gesture there (the nav stays reachable via the ☰ button).
  const pageOwnsLeftSwipe = /\/brain(\/|$)/.test(pathname);
  const { left: leftDrag, right: rightDrag } = useDrawerGesture({
    isMobile: isMobile && !pageOwnsLeftSwipe,
    left: leftConfig,
    right: rightConfig,
  });

  // Forward the right panel's live drag back to the page that owns it (the session
  // inspector), so it tracks the finger / snaps just like the left drawer.
  useEffect(() => {
    handle?.setDrag(rightDrag.dragging, rightDrag.progress);
  }, [handle, rightDrag.dragging, rightDrag.progress]);

  // Close the left drawer on navigation (covers nav-link taps). Adjust state during
  // render per React's "you might not need an effect" guidance.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    if (open) setOpen(false);
  }

  // Lock body scroll + close on Escape while the left drawer is open on mobile.
  useEffect(() => {
    if (!(isMobile && open)) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [isMobile, open]);

  return (
    <Ctx.Provider value={{ open, setOpen, isMobile }}>
      <div
        ref={drawerRef}
        className={cn(
          "shrink-0",
          isMobile &&
            "fixed inset-y-0 left-0 z-40 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] transition-transform duration-200 ease-out",
          isMobile && (open ? "translate-x-0" : "-translate-x-full"),
        )}
        // While dragging, follow the finger 1:1: the inline transform overrides the
        // translate class and `transition: none` disables the snap until release.
        style={
          isMobile && leftDrag.dragging
            ? { transform: `translateX(${(leftDrag.progress - 1) * 100}%)`, transition: "none" }
            : undefined
        }
      >
        {sidebar}
      </div>

      {isMobile && (open || leftDrag.dragging) ? (
        <button
          type="button"
          aria-label="Close menu"
          data-testid="drawer-scrim"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-black/40"
          // Fade the dim in step with the drag; full strength once open.
          style={leftDrag.dragging ? { opacity: leftDrag.progress } : undefined}
        />
      ) : null}

      {children}
    </Ctx.Provider>
  );
}
