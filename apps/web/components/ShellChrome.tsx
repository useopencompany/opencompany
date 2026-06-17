"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
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
 * The server `AppShell` passes the (server-rendered) sidebar tree as `sidebar` and the
 * page as `children`.
 */
export function ShellChrome({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer on navigation (covers nav-link taps, which change the path).
  // biome-ignore lint/correctness/useExhaustiveDependencies: close only when the path changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll + close on Escape while the drawer is open on mobile.
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
        className={cn(
          "shrink-0",
          isMobile && "fixed inset-y-0 left-0 z-40 transition-transform duration-200 ease-out",
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
