// PR 3 ships the canonical browser path behind an explicit rollback switch. PR 4 may make this
// the default only after runner parity and rollout evidence satisfy issue #1165.
export const HEADLESS_CHAT_ENABLED = process.env.NEXT_PUBLIC_GOAT_HEADLESS_CHAT === "true";

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
