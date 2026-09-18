"use server";

import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiError, serverApiErrorMessage } from "@/lib/server-api-client";

export type DopplerAuthSettings = {
  status: "connected" | "needs_reauth" | "disconnected" | null;
  statusReason: string | null;
  accountName: string | null;
  lastValidatedAt: string | null;
};
export type DopplerAuthFlow = {
  id: string;
  status: "pending" | "link_ready" | "completed" | "failed" | "expired";
  loginUrl: string | null;
  userCode: string | null;
  statusReason: string | null;
  expiresAt: string;
};
export async function loadCurrentDopplerAuthSettings(): Promise<DopplerAuthSettings> {
  const response = await (await serverApiClient()).v1["engine-auth"].doppler.$get();
  if (!response.ok) throw await serverApiError(response, "Could not load the Doppler connection.");
  return (await response.json()).data;
}
export async function startDopplerAuth() {
  try {
    const response = await (await serverApiClient()).v1["engine-auth"].doppler.start.$post();
    if (!response.ok)
      return {
        ok: false as const,
        error: await serverApiErrorMessage(response, "Could not start Doppler sign-in."),
      };
    return { ok: true as const, flow: (await response.json()).data.flow };
  } catch {
    return { ok: false as const, error: "Could not start Doppler sign-in. Please try again." };
  }
}
export async function pollDopplerAuth(flowId: string) {
  try {
    const response = await (await serverApiClient()).v1["engine-auth"].doppler[
      ":flowId"
    ].poll.$post({ param: { flowId } });
    if (!response.ok)
      return {
        ok: false as const,
        error: await serverApiErrorMessage(response, "Could not check Doppler sign-in."),
      };
    const flow = (await response.json()).data.flow;
    if (flow.status === "completed") {
      revalidatePath("/plugins/doppler");
      revalidatePath("/plugins");
    }
    return { ok: true as const, flow };
  } catch {
    return { ok: false as const, error: "Could not check Doppler sign-in. Please try again." };
  }
}
export async function cancelDopplerAuth(disconnect: boolean) {
  try {
    const api = (await serverApiClient()).v1["engine-auth"].doppler;
    const response = disconnect ? await api.$delete() : await api.cancel.$post();
    if (!response.ok)
      return {
        ok: false as const,
        error: await serverApiErrorMessage(response, "Could not disconnect Doppler."),
      };
    revalidatePath("/plugins/doppler");
    revalidatePath("/plugins");
    return { ok: true as const };
  } catch {
    return { ok: false as const, error: "Could not disconnect Doppler. Please try again." };
  }
}
