"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import {
  GOAT_ONBOARDING_CONNECTION_MESSAGE,
  GOAT_ONBOARDING_CONNECTION_STORAGE_KEY,
  type GoatOnboardingConnectionMessage,
} from "@/lib/onboarding-integrations";

function ConnectionNotifier() {
  const params = useSearchParams();

  useEffect(() => {
    const message: GoatOnboardingConnectionMessage = {
      type: GOAT_ONBOARDING_CONNECTION_MESSAGE,
      provider: params.get("integration"),
      status: params.get("setup"),
      reason: params.get("reason"),
    };

    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(message, window.location.origin);
      window.close();
      return;
    }

    window.localStorage.setItem(
      GOAT_ONBOARDING_CONNECTION_STORAGE_KEY,
      JSON.stringify({ ...message, completedAt: Date.now() }),
    );

    const next = new URL("/onboarding", window.location.origin);
    for (const key of ["integration", "setup", "reason"] as const) {
      const value = params.get(key);
      if (value) next.searchParams.set(key, value);
    }
    const timer = window.setTimeout(() => {
      window.location.replace(`${next.pathname}${next.search}`);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [params]);

  return null;
}

export default function OnboardingConnectedPage() {
  return (
    <main className="flex h-dvh w-full items-center justify-center bg-canvas px-6 text-ink">
      <p className="text-[13px] text-ink-subtle">Finishing your connection...</p>
      <Suspense fallback={null}>
        <ConnectionNotifier />
      </Suspense>
    </main>
  );
}
