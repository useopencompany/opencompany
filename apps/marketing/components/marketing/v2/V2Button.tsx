"use client";

import { captureMarketingEvent } from "@opencompany/analytics/marketing/client";
import type { MarketingCta } from "@opencompany/analytics/marketing/events";
import { cn } from "@opencompany/ui/lib/utils";

/**
 * Buttons in this design are deliberately small — 32px tall, 10px of horizontal
 * padding, 12px type — so they read as controls rather than billboards.
 *
 * It reports the same `marketing_clicked_demo` / `marketing_clicked_signup`
 * events as the homepage's `Cta`. Without that the variant would be visually
 * comparable to `/` but not measurably comparable, which is the whole reason
 * the page exists.
 */
export function Button({
  href,
  variant = "primary",
  analyticsIntent,
  className,
  children,
}: {
  href: string;
  variant?: "primary" | "secondary" | "onDark";
  analyticsIntent?: MarketingCta;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      onClick={() => {
        if (analyticsIntent) {
          captureMarketingEvent(
            analyticsIntent === "signup" ? "marketing_clicked_signup" : "marketing_clicked_demo",
            {},
          );
        }
      }}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-[6px] px-2.5 text-[12px] leading-[1.45] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        variant === "primary" && "bg-[#0a0a0a] text-white hover:bg-[#0a0a0a]/90",
        variant === "secondary" &&
          "bg-foreground/[0.04] text-foreground hover:bg-foreground/[0.08]",
        variant === "onDark" && "bg-white/90 text-[#0a0a0a] hover:bg-white",
        className,
      )}
    >
      {children}
    </a>
  );
}
