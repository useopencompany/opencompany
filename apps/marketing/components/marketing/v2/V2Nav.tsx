import { cn } from "@opencompany/ui/lib/utils";
import Link from "next/link";
import { Mark } from "../Mark";
import { Button } from "./primitives";

const NAV_LINKS = [
  { href: "/use-cases", label: "Use cases", external: false },
  { href: "/pricing", label: "Pricing", external: false },
  { href: "/blog", label: "Blog", external: false },
  { href: "https://my.opencompany.chat/changelog", label: "Changelog", external: true },
] as const;

const LINK_CLASS =
  "flex h-7 items-center rounded-[6px] px-2 text-[12px] text-foreground/60 leading-[1.45] transition-colors hover:text-foreground";

/**
 * Floating pill navigation: a single translucent capsule centered 16px below the
 * top of the viewport, rather than a full-width bar. Nothing in it is taller than
 * 28px, which is what keeps the header reading as a control strip over the page.
 */
export function V2Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 flex justify-center p-4">
      <div className="flex items-center gap-1 rounded-[10px] bg-foreground/[0.035] px-1 py-0.5 backdrop-blur-md">
        <Link
          href="/"
          className="flex h-7 items-center gap-1.5 px-2 text-foreground"
          aria-label="opencompany home"
        >
          <Mark className="size-[15px]" />
          <span className="text-[15px] leading-none tracking-[-0.01em]">opencompany</span>
        </Link>

        <nav aria-label="Primary navigation" className="hidden items-center md:flex">
          {NAV_LINKS.map((item) =>
            item.external ? (
              <a key={item.href} href={item.href} className={LINK_CLASS}>
                {item.label}
              </a>
            ) : (
              <Link key={item.href} href={item.href} className={LINK_CLASS}>
                {item.label}
              </Link>
            ),
          )}
        </nav>

        <span aria-hidden="true" className="mx-2 hidden h-4 w-px bg-foreground/10 md:block" />

        <a href="https://my.opencompany.chat" className={LINK_CLASS}>
          Log in
        </a>
        <Button href="/request-demo" className="h-7">
          Request demo
        </Button>

        {/* Below `md` the link row is hidden, so the same links move into a
            disclosure menu rather than becoming unreachable. */}
        <details className="group relative md:hidden">
          <summary className="flex size-7 cursor-pointer list-none items-center justify-center rounded-[6px] text-foreground/60 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span className="sr-only">Toggle navigation menu</span>
            <svg
              aria-hidden="true"
              className="size-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path strokeLinecap="round" className="group-open:hidden" d="M4 8h16M4 16h16" />
              <path
                strokeLinecap="round"
                className="hidden group-open:block"
                d="m6 6 12 12M18 6 6 18"
              />
            </svg>
          </summary>
          <nav
            aria-label="Mobile navigation"
            className="absolute top-[calc(100%+0.5rem)] right-0 w-44 rounded-[8px] border border-border bg-background p-1 shadow-lg"
          >
            {NAV_LINKS.map((item) =>
              item.external ? (
                <a key={item.href} href={item.href} className={cn(LINK_CLASS, "h-8 w-full")}>
                  {item.label}
                </a>
              ) : (
                <Link key={item.href} href={item.href} className={cn(LINK_CLASS, "h-8 w-full")}>
                  {item.label}
                </Link>
              ),
            )}
          </nav>
        </details>
      </div>
    </header>
  );
}
