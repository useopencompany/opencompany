"use client";

import { useEffect, useState } from "react";
import {
  type ContextReferenceCatalog,
  fetchContextReferenceCatalog,
} from "@/lib/context-reference-catalog";

export function useContextReferenceCatalog(open: boolean) {
  const [catalog, setCatalog] = useState<ContextReferenceCatalog>({ items: [], error: null });
  const [completed, setCompleted] = useState(false);
  const [previousOpen, setPreviousOpen] = useState(open);
  if (open !== previousOpen) {
    setPreviousOpen(open);
    setCompleted(false);
  }
  useEffect(() => {
    if (!open) return;
    let active = true;
    void fetchContextReferenceCatalog()
      .then((result) => {
        if (active) setCatalog(result);
      })
      .catch(() => {
        if (active)
          setCatalog({
            items: [],
            error: "Mentions could not be loaded. Close and reopen to retry.",
          });
      })
      .finally(() => {
        if (active) setCompleted(true);
      });
    return () => {
      active = false;
    };
  }, [open]);
  return { ...catalog, loading: open && !completed };
}
