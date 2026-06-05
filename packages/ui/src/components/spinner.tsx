import { Loader2 } from "@opencompany/ui/icons";
import { cn } from "@opencompany/ui/lib/utils";
import type * as React from "react";

function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2>) {
  return (
    <Loader2
      role="status"
      aria-label="Loading"
      data-slot="spinner"
      className={cn("size-4 animate-spin text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Spinner };
