"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@opencompany/ui/lib/utils";
import type * as React from "react";

function Switch({
  className,
  ...props
}: Omit<React.ComponentProps<typeof SwitchPrimitive.Root>, "className"> & { className?: string }) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent p-0.5 outline-none transition-colors",
        "bg-input data-[checked]:bg-primary",
        "focus-visible:ring-2 focus-visible:ring-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform",
          "data-[checked]:translate-x-4 data-[unchecked]:translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
