"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "@opencompany/ui/lib/utils";
import type * as React from "react";

type WithClass<T> = Omit<T, "className"> & { className?: string };

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverClose = PopoverPrimitive.Close;

function PopoverContent({
  className,
  sideOffset = 6,
  align = "center",
  side,
  ...props
}: WithClass<React.ComponentProps<typeof PopoverPrimitive.Popup>> & {
  sideOffset?: number;
  align?: "start" | "center" | "end";
  side?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["side"];
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        sideOffset={sideOffset}
        align={align}
        side={side}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "w-72 origin-[var(--transform-origin)] rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md outline-none",
            "transition-all duration-150",
            "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverClose, PopoverContent, PopoverTrigger };
