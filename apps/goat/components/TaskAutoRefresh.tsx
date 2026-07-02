"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function TaskAutoRefresh({ enabled }: { enabled: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) return;
    const interval = window.setInterval(() => {
      router.refresh();
    }, 2_500);
    return () => window.clearInterval(interval);
  }, [enabled, router]);

  return null;
}
