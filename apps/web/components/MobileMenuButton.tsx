"use client";

import { PanelLeft } from "lucide-react";
import { useDrawer } from "@/components/ShellChrome";

/**
 * Bottom-left, thumb-reachable button that opens the mobile drawer. Renders only
 * on mobile and only while the drawer is closed; hidden entirely on desktop.
 */
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
