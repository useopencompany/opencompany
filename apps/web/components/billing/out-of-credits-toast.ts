import type { useRouter } from "next/navigation";
import type { useToast } from "@/components/ToastProvider";

type ShowOutOfCreditsToastInput = {
  showToast: ReturnType<typeof useToast>["showToast"];
  router: ReturnType<typeof useRouter>;
  redirectTo: string;
};

export function showOutOfCreditsToast({
  showToast,
  router,
  redirectTo,
}: ShowOutOfCreditsToastInput) {
  showToast({
    title: "You're out of credits",
    description: "Add credits to start a new agent session.",
    tone: "error",
    action: {
      label: "Add credits",
      onClick: () => router.push(redirectTo),
    },
  });
}
