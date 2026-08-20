"use client";

import { useEffect } from "react";

// Fires the deep link back into the desktop app once, on mount. The visible
// manual link in the parent page is the fallback if the browser blocks the
// automatic scheme navigation.
export function DesktopReturnRedirect({ deepLink }: { deepLink: string }) {
  useEffect(() => {
    window.location.href = deepLink;
  }, [deepLink]);
  return null;
}
