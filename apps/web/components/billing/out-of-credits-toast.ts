import type { useRouter } from "next/navigation";
import type { useToast } from "@/components/ToastProvider";

type ShowOutOfCreditsToastInput = {
  showToast: ReturnType<typeof useToast>["showToast"];
  router: ReturnType<typeof useRouter>;
  redirectTo: string;
  // Distinguishes an empty balance from hitting the weekly spending limit so the
  // toast points the user at the right fix. Defaults to the out-of-credits copy.
  reason?: string | undefined;
};

export function showOutOfCreditsToast({
  showToast,
  router,
  redirectTo,
  reason = "no_balance",
}: ShowOutOfCreditsToastInput) {
  const isLimit = reason === "weekly_limit_reached";
  showToast({
    title: isLimit ? "Weekly spending limit reached" : "You're out of credits",
    description: isLimit
      ? "Raise your weekly limit to keep running agents."
      : "Add credits to start a new agent session.",
    tone: "error",
    action: {
      label: isLimit ? "Adjust limit" : "Add credits",
      onClick: () => router.push(redirectTo),
    },
  });
}
