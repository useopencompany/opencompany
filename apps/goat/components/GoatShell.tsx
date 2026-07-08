"use client";

import { PanelLeft } from "lucide-react";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { GoatNavInsetProvider } from "@/components/GoatNavInset";
import { GoatSidebar } from "@/components/GoatSidebar";

const SIDEBAR_STORAGE_KEY = "goat-sidebar-collapsed";
const sidebarCollapsedSubscribers = new Set<() => void>();

function subscribeSidebarCollapsed(onStoreChange: () => void) {
  sidebarCollapsedSubscribers.add(onStoreChange);

  function handleStorage(event: StorageEvent) {
    if (event.key === SIDEBAR_STORAGE_KEY) onStoreChange();
  }

  window.addEventListener("storage", handleStorage);
  return () => {
    sidebarCollapsedSubscribers.delete(onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function getSidebarCollapsedSnapshot() {
  // Expanded by default: only an explicit "true" (user collapsed it before) hides the sidebar.
  return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
}

function getSidebarCollapsedServerSnapshot() {
  return false;
}

function persistSidebarCollapsed(next: boolean) {
  window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
  for (const subscriber of sidebarCollapsedSubscribers) subscriber();
}

const MOBILE_QUERY = "(max-width: 767px)";

function subscribeIsMobile(onStoreChange: () => void) {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function getIsMobileSnapshot() {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getIsMobileServerSnapshot() {
  return false;
}

// The persistent Goat chrome: the sidebar plus the rounded main-panel wrapper. Lives in the
// (app) layout so it stays mounted across navigations (the route page renders into {children}).
export function GoatShell({ children }: { children: ReactNode }) {
  const collapsed = useSyncExternalStore(
    subscribeSidebarCollapsed,
    getSidebarCollapsedSnapshot,
    getSidebarCollapsedServerSnapshot,
  );
  const isMobile = useSyncExternalStore(
    subscribeIsMobile,
    getIsMobileSnapshot,
    getIsMobileServerSnapshot,
  );

  // On mobile the sidebar's desktop width-collapse is replaced by an off-canvas drawer.
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the drawer on navigation (covers sidebar link taps). Adjust during render
  // per React's "you might not need an effect" guidance.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    if (drawerOpen) setDrawerOpen(false);
  }

  // Lock body scroll + close on Escape while the drawer is open on mobile.
  useEffect(() => {
    if (!(isMobile && drawerOpen)) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [isMobile, drawerOpen]);

  const floatingButtonVisible = isMobile ? !drawerOpen : collapsed;

  return (
    // Root backdrop: on mobile the surface is full-bleed canvas (the sidebar is an off-canvas
    // drawer); on desktop the root stays `bg-sidebar` so the expanded main panel can float as a
    // rounded card with the sidebar canvas peeking around it.
    <div className="relative flex h-dvh w-full overflow-hidden overflow-x-hidden bg-canvas md:bg-sidebar">
      <div
        className={
          isMobile
            ? `fixed inset-y-0 left-0 z-40 transition-transform duration-200 ease-out ${
                drawerOpen ? "translate-x-0" : "-translate-x-full"
              }`
            : "shrink-0"
        }
      >
        <GoatSidebar
          collapsed={isMobile ? false : collapsed}
          onToggleCollapsed={
            isMobile ? () => setDrawerOpen(false) : () => persistSidebarCollapsed(!collapsed)
          }
        />
      </div>

      {isMobile && drawerOpen ? (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-30 bg-black/40"
        />
      ) : null}

      {/* When the sidebar is expanded the main view floats as a rounded panel so the sidebar
          canvas peeks around its edges; collapsed (or on mobile), it bleeds to full screen. */}
      <div
        className={`relative flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas transition-[margin,border-radius] duration-200 ease-out ${
          isMobile || collapsed
            ? "m-0 rounded-none border-0"
            : "my-2 mr-2 rounded-xl border border-border shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
        }`}
      >
        {floatingButtonVisible && (
          <button
            type="button"
            aria-label={isMobile ? "Open menu" : "Expand sidebar"}
            aria-expanded={false}
            onClick={isMobile ? () => setDrawerOpen(true) : () => persistSidebarCollapsed(false)}
            className="fixed left-2 top-2 z-50 rounded-md border border-border bg-canvas/85 p-1.5 text-ink/60 shadow-[0_1px_2px_rgba(15,15,15,0.04)] backdrop-blur-md transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
          >
            <PanelLeft size={15} strokeWidth={1.75} />
          </button>
        )}
        <GoatNavInsetProvider value={floatingButtonVisible}>{children}</GoatNavInsetProvider>
      </div>
    </div>
  );
}
