"use server";

import { revalidatePath } from "next/cache";
import { currentGoatUser } from "@/lib/auth";
import { disconnectGoatStripeIntegration } from "@/lib/integrations/stripe";

export async function disconnectStripeIntegrationAction(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const context = await currentGoatUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can manage the Stripe integration." };
  }
  try {
    const disconnected = await disconnectGoatStripeIntegration(context.workspace.id);
    if (!disconnected) return { ok: false, error: "Stripe is not connected." };
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not disconnect Stripe.",
    };
  }
}
