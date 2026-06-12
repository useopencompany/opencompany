"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import {
  ONBOARDING_CONNECTED_MESSAGE,
  type OnboardingConnectedMessage,
} from "@/lib/onboarding/setups";

// Popup-closer for inline integration connect flows.
//
// Every OAuth start route (integrations + MCP) is opened in a popup with returnTo pointing here, and
// every callback redirects back to this page with a status param: integrations append
// `?integration=<id>&setup=connected|error`, MCPs append `?mcp=<id>&setup=connected|error[&reason]`.
// We normalize that into a single message to the opener (the onboarding window) and close ourselves,
// so the onboarding page can flip the row to "connected" without ever navigating away.

function ConnectedNotifier() {
  const params = useSearchParams();

  useEffect(() => {
    const message: OnboardingConnectedMessage = {
      type: ONBOARDING_CONNECTED_MESSAGE,
      provider: params.get("integration") ?? params.get("mcp"),
      status: params.get("setup"),
      reason: params.get("reason"),
    };
    try {
      window.opener?.postMessage(message, window.location.origin);
    } catch {
      // If the opener is gone (popup reused / blocked) there's nothing to notify; just close.
    }
    window.close();
  }, [params]);

  return null;
}

export default function OnboardingConnectedPage() {
  return (
    <main className="flex min-h-screen w-screen items-center justify-center bg-canvas px-6">
      <p className="text-[13px] text-ink-muted">You can close this window.</p>
      <Suspense fallback={null}>
        <ConnectedNotifier />
      </Suspense>
    </main>
  );
}
