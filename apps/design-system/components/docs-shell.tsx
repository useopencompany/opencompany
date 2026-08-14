"use client";

import { BrandMark } from "@opencompany/ui/icons";
import { cn } from "@opencompany/ui/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type * as React from "react";
import { CommandMenu } from "@/components/command-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { NAV_SECTIONS } from "@/lib/site";

export function DocsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-[1400px]">
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
          <div className="flex h-14 items-center gap-2 px-5">
            <BrandMark className="size-5 text-foreground" />
            <span className="text-sm font-semibold">design system</span>
          </div>
          <nav className="flex-1 overflow-y-auto px-3 pt-6 pb-8">
            {NAV_SECTIONS.map((section) => (
              <div key={section.title} className="mb-6">
                <p className="px-2 pb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {section.title}
                </p>
                <ul className="flex flex-col gap-0.5">
                  {section.items.map((item) => {
                    const active = pathname === item.href;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          className={cn(
                            "block rounded-md px-2 py-1.5 text-sm transition-colors",
                            active
                              ? "bg-accent font-medium text-accent-foreground"
                              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                          )}
                        >
                          {item.title}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-border bg-background/80 px-6 backdrop-blur">
            <span className="text-sm font-medium text-muted-foreground md:hidden">
              opencompany DS
            </span>
            <div className="ml-auto flex items-center gap-2">
              <CommandMenu />
              <ThemeToggle />
            </div>
          </header>
          <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10 lg:py-14">{children}</main>
        </div>
      </div>
    </div>
  );
}
