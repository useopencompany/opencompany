// Canonical Chat remains a configuration cohort while its separately deployed API is active.
// Enabling is code-free; removing/false is the immediate rollback to legacy Chat.
export function isHeadlessChatEnabled(value = process.env.NEXT_PUBLIC_GOAT_HEADLESS_CHAT) {
  return value === "true";
}

export const HEADLESS_CHAT_ENABLED = isHeadlessChatEnabled();

export function hasChatAttachmentTransportMismatch(
  attachments: readonly { id?: string; blobUrl?: string; blobPathname?: string }[],
  canonicalTarget: boolean,
) {
  return attachments.some((attachment) => {
    const hasLegacyLocator = Boolean(attachment.blobUrl || attachment.blobPathname);
    const hasCompleteLegacyLocator = Boolean(attachment.blobUrl && attachment.blobPathname);
    return canonicalTarget ? hasLegacyLocator : !hasCompleteLegacyLocator;
  });
}
