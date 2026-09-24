"use client";

import { Button } from "@opencompany/ui/components/button";
import { ArrowDownToLine } from "lucide-react";
import { useEffect, useState } from "react";

// Appears once the macOS shell has staged an update. Shells released before
// the update bridge lack `onUpdateReady` and keep installing on quit.
export function DesktopUpdateButton() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => window.opencompanyDesktop?.onUpdateReady?.(setVersion), []);

  if (!version) return null;

  return (
    <Button
      size="sm"
      title={`Restart to install opencompany ${version}`}
      onClick={() => window.opencompanyDesktop?.restartToUpdate?.()}
      className="mr-1 h-7 gap-1.5 rounded-md px-2.5 text-[12.5px]"
    >
      <ArrowDownToLine size={13} strokeWidth={2} />
      Update
    </Button>
  );
}
