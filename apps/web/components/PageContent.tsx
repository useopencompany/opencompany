"use client";

import { cn } from "@opencompany/ui/lib/utils";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

// Shared content shell for the app's document-style pages (settings, Plugins, Skills): a
// scrollable, left-aligned column with a consistent header. Navigation lives in whichever
// sidebar is mounted, so pages only own their body.
export function PageContent({
  title,
  description,
  backLink,
  icon,
  badge,
  contentClassName,
  children,
}: {
  title: string;
  description?: string;
  backLink?: { href: string; label: string };
  /** Optional mark rendered beside the page title, for pages about a single named thing. */
  icon?: ReactNode;
  /** Optional status pill rendered beside the page title. */
  badge?: ReactNode;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 overflow-y-auto px-6 md:px-10">
        <div
          className={cn(
            "mx-auto flex w-full max-w-[680px] flex-col gap-8 pb-24 pt-14 sm:pt-20",
            contentClassName,
          )}
        >
          {backLink ? (
            <Link
              href={backLink.href}
              prefetch
              className="-mb-4 inline-flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-ink-subtle transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
            >
              <ArrowLeft size={14} strokeWidth={2} />
              {backLink.label}
            </Link>
          ) : null}
          <header className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              {icon}
              <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">
                {title}
              </h1>
              {badge}
            </div>
            {description ? (
              <p className="text-[13px] leading-5 text-ink-subtle">{description}</p>
            ) : null}
          </header>
          {children}
        </div>
      </div>
    </main>
  );
}
