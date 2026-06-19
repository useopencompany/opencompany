"use client";

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

/**
 * A page-specific right panel (the session-details inspector) registers a handle
 * here so the global swipe gesture in `ShellChrome` can open/close and finger-drag
 * it without `ShellChrome` knowing anything about sessions. Mirrors the existing
 * `SessionDragContext` registration pattern.
 *
 * The provider sits ABOVE `ShellChrome` (in `AppShell`) so both the gesture
 * (consumer) and the session page (registrar) — which are siblings under it —
 * share one instance. Outside a provider the hook returns a no-op, so a session
 * rendered in a shell without the gesture (e.g. the personal surface) just works.
 */
export type RightPanelHandle = {
  /** Current open state, read live by the gesture at pointer-down. */
  isOpen: () => boolean;
  /** Commit the panel open/closed (the gesture calls this on release). */
  setOpen: (open: boolean) => void;
  /** Live drag feedback (0 = closed → 1 = open) so the panel can track the finger. */
  setDrag: (dragging: boolean, progress: number) => void;
  /** Measured panel width in px, for progress math. */
  getWidth: () => number;
};

type MobileInspectorValue = {
  handle: RightPanelHandle | null;
  register: (handle: RightPanelHandle | null) => void;
};

const MobileInspectorContext = createContext<MobileInspectorValue>({
  handle: null,
  register: () => {},
});

export function MobileInspectorProvider({ children }: { children: ReactNode }) {
  const [handle, setHandle] = useState<RightPanelHandle | null>(null);
  const register = useCallback((next: RightPanelHandle | null) => setHandle(next), []);
  const value = useMemo(() => ({ handle, register }), [handle, register]);
  return (
    <MobileInspectorContext.Provider value={value}>{children}</MobileInspectorContext.Provider>
  );
}

export function useMobileInspector(): MobileInspectorValue {
  return useContext(MobileInspectorContext);
}
