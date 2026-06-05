"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@opencompany/ui/lib/utils";
import type * as React from "react";

type WithClass<T> = Omit<T, "className"> & { className?: string };

function Tabs({ className, ...props }: WithClass<React.ComponentProps<typeof TabsPrimitive.Root>>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function TabsList({
  className,
  ...props
}: WithClass<React.ComponentProps<typeof TabsPrimitive.List>>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "relative inline-flex h-9 w-fit items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function TabsTab({
  className,
  ...props
}: WithClass<React.ComponentProps<typeof TabsPrimitive.Tab>>) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        "z-10 inline-flex h-7 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium outline-none transition-colors",
        "text-muted-foreground data-[selected]:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/40",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function TabsIndicator({
  className,
  ...props
}: WithClass<React.ComponentProps<typeof TabsPrimitive.Indicator>>) {
  return (
    <TabsPrimitive.Indicator
      data-slot="tabs-indicator"
      className={cn(
        "absolute top-1 left-0 z-0 h-7 w-[var(--active-tab-width)] translate-x-[var(--active-tab-left)] rounded-md bg-background shadow-sm transition-all duration-200 ease-out",
        className,
      )}
      {...props}
    />
  );
}

function TabsPanel({
  className,
  ...props
}: WithClass<React.ComponentProps<typeof TabsPrimitive.Panel>>) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab };
