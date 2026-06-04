"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};

/**
 * Returns false on the server and on the client's first (hydration) render,
 * then true after mount. Use it to gate client-only hooks like TanStack DB's
 * `useLiveQuery`, which calls `useSyncExternalStore` without a server snapshot
 * and throws if rendered on the server.
 *
 * Implemented with `useSyncExternalStore` (server snapshot `false`, client
 * snapshot `true`) so the hydrated output matches the server HTML with no
 * hydration mismatch and no setState-in-effect.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}
