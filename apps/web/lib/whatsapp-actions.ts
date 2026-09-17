"use server";

import type { WhatsappSettingsDto } from "@opencompany/protocol";
import { revalidatePath } from "next/cache";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";

export type WhatsappActionResult =
  | { ok: true; data: WhatsappSettingsDto }
  | { ok: false; error: string };

export async function startWhatsappLinkAction(): Promise<WhatsappActionResult> {
  try {
    const response = await (await serverApiClient()).v1.me.whatsapp.link.$post();
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not create a link code."),
      };
    }
    revalidatePath("/settings/whatsapp");
    return { ok: true, data: (await response.json()).data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not create a link code.",
    };
  }
}

export async function unlinkWhatsappAction(): Promise<WhatsappActionResult> {
  try {
    const response = await (await serverApiClient()).v1.me.whatsapp.$delete();
    if (!response.ok) {
      return {
        ok: false,
        error: await serverApiErrorMessage(response, "Could not unlink your phone."),
      };
    }
    revalidatePath("/settings/whatsapp");
    return { ok: true, data: (await response.json()).data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not unlink your phone.",
    };
  }
}
