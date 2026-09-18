"use client";

import { useEffect } from "react";

export const COMPLETED_CONVERSATION_DOCUMENT_TITLE = "Done · opencompany";

/**
 * Turns the browser tab into a quiet completion cue while the reader is elsewhere.
 *
 * The conversation read model already decides whether a result is unseen. This hook only presents
 * that state and gives title ownership back as soon as the tab is visible or the pane is inactive.
 */
export function useConversationTabTitle({
  active,
  completedUnseen,
}: {
  active: boolean;
  completedUnseen: boolean;
}) {
  useEffect(() => {
    if (!active) return;

    const normalTitle = document.title;
    const syncTitle = () => {
      document.title =
        completedUnseen && document.visibilityState === "hidden"
          ? COMPLETED_CONVERSATION_DOCUMENT_TITLE
          : normalTitle;
    };

    syncTitle();
    document.addEventListener("visibilitychange", syncTitle);
    return () => {
      document.removeEventListener("visibilitychange", syncTitle);
      document.title = normalTitle;
    };
  }, [active, completedUnseen]);
}
