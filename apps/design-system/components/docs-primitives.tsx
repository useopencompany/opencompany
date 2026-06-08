import { cn } from "@opencompany/ui/lib/utils";
import type * as React from "react";

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-10">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      {description ? <p className="mt-2 text-base text-muted-foreground">{description}</p> : null}
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-12 mb-4 text-sm font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

/** A bordered canvas used to display a live component example. */
export function Preview({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-32 flex-wrap items-center justify-center gap-4 rounded-lg border border-border bg-card p-8",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ExampleBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h3 className="mb-3 text-sm font-medium text-foreground">{title}</h3>
      <Preview>{children}</Preview>
    </section>
  );
}
