import { getDb } from "./client";
import { createPhoneChannelBindings } from "./phone-channel-bindings";
import { whatsappIngressReceipts } from "./product-schema";
export const WHATSAPP_LINK_CODE_TTL_MS = 10 * 60 * 1000;
export function isWhatsappLinkCode(text: string) {
  return /^\d{12}$/.test(text.trim());
}
const bindings = createPhoneChannelBindings("whatsapp");
export const getWhatsappBinding = bindings.getBinding;
export const startWhatsappLink = bindings.startLink;
export const deleteWhatsappBinding = bindings.unlink;
export const completeWhatsappLink = bindings.completeLink;
export const touchWhatsappBindingInbound = bindings.touchInbound;
export const getWhatsappBindingForConversation = bindings.getForConversation;
export async function findLinkedWhatsappBinding(...args: Parameters<typeof bindings.findLinked>) {
  const result = await bindings.findLinked(...args);
  return result
    ? {
        binding: result.binding,
        workspaceRole: result.workspaceRole,
        whatsappEnabled: result.enabled,
      }
    : null;
}
export type LinkedWhatsappBinding = NonNullable<
  Awaited<ReturnType<typeof findLinkedWhatsappBinding>>
>;

// The receipt and local mutations commit together. A database failure rolls back the receipt,
// allowing Kapso to retry; a duplicate after success never reroutes a code or replays STOP.
export async function acceptWhatsappEvent(
  id: string,
  handle: (tx: any) => Promise<void>,
  db: any = getDb(),
) {
  return db.transaction(async (tx: any) => {
    const rows = await tx
      .insert(whatsappIngressReceipts)
      .values({ id })
      .onConflictDoNothing()
      .returning({ id: whatsappIngressReceipts.id });
    if (!rows.length) return false;
    await handle(tx);
    return true;
  });
}
