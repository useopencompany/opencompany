"use client";

import { useEffect, useState } from "react";

const MOBILE_QUERY = "(max-width: 767px)"; // below Tailwind `md`

/**
 * True when the viewport is narrower than the `md` breakpoint. Starts `false`
 * so SSR / first paint matches the desktop layout, then corrects on mount.
 * Pure-CSS responsive styling (`md:` prefixes) doesn't need this — use it only
 * where stateful behavior depends on viewport (e.g. the mobile drawer).
 */
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
