"use client";

import type * as React from "react";
import { Toaster as Sonner, type ToasterProps, toast } from "sonner";

/**
 * Toast notifications, powered by Sonner.
 *
 * Colors are wired to the design-system tokens via Sonner's CSS variables so the
 * toaster matches whichever theme (`data-theme`) is active. Pass `theme` from the
 * app's theme provider for crisp light/dark switching.
 */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster, toast };
