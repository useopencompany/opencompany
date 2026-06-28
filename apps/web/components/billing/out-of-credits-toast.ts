import type { useRouter } from "next/navigation";
import type { useToast } from "@/components/ToastProvider";

type ShowOutOfCreditsToastInput = {
  showToast: ReturnType<typeof useToast>["showToast"];
  router: ReturnType<typeof useRouter>;
  redirectTo: string;
  // Distinguishes an empty balance from hitting a spending limit so the toast points
  // the user at the right fix. Defaults to the out-of-credits copy. Kept as a plain
  // string (not the billing RunAllowanceReason type) so this client module doesn't
  // pull the server-side billing package into the browser bundle.
  reason?: string | undefined;
};

export function showOutOfCreditsToast({
  showToast,
  router,
  redirectTo,
  reason = "no_balance",
}: ShowOutOfCreditsToastInput) {
  // daily/weekly map to the limit copy; anything else falls back to out-of-credits.
  const limitWindow =
    reason === "daily_limit_reached"
      ? "daily"
      : reason === "weekly_limit_reached"
        ? "weekly"
        : null;
  showToast({
    title: limitWindow
      ? `${limitWindow === "daily" ? "Daily" : "Weekly"} spending limit reached`
      : "You're out of credits",
    description: limitWindow
      ? `Raise your ${limitWindow} limit to keep running agents.`
      : "Add credits to start a new agent session.",
    tone: "error",
    action: {
      label: limitWindow ? "Adjust limit" : "Add credits",
      onClick: () => router.push(redirectTo),
    },
  });
}
