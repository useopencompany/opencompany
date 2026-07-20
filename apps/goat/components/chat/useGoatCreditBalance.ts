"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type GoatCreditBalanceState = {
  balanceUsdMicros: number;
  lowBalanceWarnUsdMicros: number;
  enforcementEnabled: boolean;
};

// Client-side view of the workspace credit balance for the chat surface.
// Fetched on mount and refetched after each finished turn (and on a 402), so
// the low-balance warning and out-of-credits hard stop track real spend. The
// display is best-effort — the server 402 gate is the source of truth.
export function useGoatCreditBalance() {
  const [balance, setBalance] = useState<GoatCreditBalanceState | null>(null);
  const inFlight = useRef(false);
  const refetch = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch("/api/billing/balance", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as Partial<GoatCreditBalanceState>;
      if (typeof data.balanceUsdMicros !== "number") return;
      setBalance({
        balanceUsdMicros: data.balanceUsdMicros,
        lowBalanceWarnUsdMicros:
          typeof data.lowBalanceWarnUsdMicros === "number" ? data.lowBalanceWarnUsdMicros : 0,
        enforcementEnabled: Boolean(data.enforcementEnabled),
      });
    } catch {
      // Keep the last known balance on transient fetch failures.
    } finally {
      inFlight.current = false;
    }
  }, []);
  useEffect(() => {
    // The state update happens asynchronously after the balance request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refetch();
  }, [refetch]);
  return { balance, refetch };
}
