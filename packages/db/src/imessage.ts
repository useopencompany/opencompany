import { createPhoneChannelBindings } from "./phone-channel-bindings";
export const IMESSAGE_LINK_CODE_TTL_MS = 10 * 60 * 1000;
export function isImessageLinkCode(text: string) {
  return /^\d{6}$/.test(text.trim());
}
const bindings = createPhoneChannelBindings("imessage");
export const getImessageBinding = bindings.getBinding;
export const startImessageLink = bindings.startLink;
export const deleteImessageBinding = bindings.unlink;
export const completeImessageLink = bindings.completeLink;
export const touchImessageBindingInbound = bindings.touchInbound;
export const getImessageBindingForConversation = bindings.getForConversation;
export async function findLinkedImessageBinding(...args: Parameters<typeof bindings.findLinked>) {
  const result = await bindings.findLinked(...args);
  return result
    ? {
        binding: result.binding,
        workspaceRole: result.workspaceRole,
        imessageEnabled: result.enabled,
      }
    : null;
}
export type LinkedImessageBinding = NonNullable<
  Awaited<ReturnType<typeof findLinkedImessageBinding>>
>;
