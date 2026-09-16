"use server";

import type { ImessageSettingsDto } from "@opencompany/protocol";
import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type ImessageActionResult =
  | { ok: true; data: ImessageSettingsDto }
  | { ok: false; error: string };

export async function startImessageLinkAction(): Promise<ImessageActionResult> {
  try {
    const response = await (await serverApiClient()).v1.me.imessage.link.$post();
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not create a link code."),
      };
    }
    revalidatePath("/settings/imessage");
    return { ok: true, data: (await response.json()).data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not create a link code.",
    };
  }
}

export async function unlinkImessageAction(): Promise<ImessageActionResult> {
  try {
    const response = await (await serverApiClient()).v1.me.imessage.$delete();
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not unlink your phone."),
      };
    }
    revalidatePath("/settings/imessage");
    return { ok: true, data: (await response.json()).data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not unlink your phone.",
    };
  }
}
