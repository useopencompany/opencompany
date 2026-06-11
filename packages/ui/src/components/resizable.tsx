"use client";

import { Group, Panel, Separator } from "react-resizable-panels";
import { cn } from "@opencompany/ui/lib/utils";
import type * as React from "react";

type ResizablePanelGroupProps = React.ComponentProps<typeof Group>;

function ResizablePanelGroup({ className, ...props }: ResizablePanelGroupProps) {
  return (
    <Group
      data-slot="resizable-panel-group"
      // sizing/display come from the lib's inline styles (overrides need the style prop)
      className={className}
      {...props}
    />
  );
}

type ResizablePanelProps = React.ComponentProps<typeof Panel>;

function ResizablePanel({ className, ...props }: ResizablePanelProps) {
  return (
    <Panel
      data-slot="resizable-panel"
      className={className}
      {...props}
    />
  );
}

type ResizableHandleProps = React.ComponentProps<typeof Separator> & {
  withHandle?: boolean;
};

function ResizableHandle({ className, withHandle = false, ...props }: ResizableHandleProps) {
  return (
    <Separator
      data-slot="resizable-handle"
      className={cn(
        // styles horizontal groups (vertical 1px divider) only; the lib provides
        // an enlarged drag hit area itself (resizeTargetMinimumSize)
        "relative flex w-px shrink-0 items-center justify-center bg-border",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong",
        // drag state is the VALUE of data-separator: inactive | hover | focus | active | disabled
        "data-[separator=hover]:bg-border-strong data-[separator=active]:bg-border-strong",
        "transition-colors",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-6 w-3 items-center justify-center rounded-sm border border-border bg-border">
          <div className="h-4 w-px rounded-full bg-border-strong" />
        </div>
      )}
    </Separator>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
