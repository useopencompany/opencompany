"use client";

import * as TogglePrimitive from "@radix-ui/react-toggle";
import * as React from "react";
import { cn } from "@/lib/utils";

const Toggle = React.forwardRef<
  React.ComponentRef<typeof TogglePrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TogglePrimitive.Root>
>(({ className, ...props }, ref) => (
  <TogglePrimitive.Root
    ref={ref}
    className={cn(
      "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink outline-none transition-colors duration-150 hover:bg-surface-muted focus-visible:ring-1 focus-visible:ring-ink/20 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:border-ink data-[state=on]:bg-ink data-[state=on]:text-canvas data-[state=on]:shadow-[0_1px_2px_rgba(0,0,0,0.18)]",
      className,
    )}
    {...props}
  />
));
Toggle.displayName = TogglePrimitive.Root.displayName;

export { Toggle };
