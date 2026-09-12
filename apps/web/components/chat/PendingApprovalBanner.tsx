"use client";

import { ShieldQuestion } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import type { PendingApproval } from "./approval-presentation";

// A decision nobody sees is a stalled conversation: the agent stops working while the transcript
// looks idle. When a pending approval card is scrolled out of the thread, this banner sits above
// the composer and takes the user back to it.

export const APPROVAL_CARD_ID_ATTRIBUTE = "data-approval-id";
export const APPROVAL_PRIMARY_BUTTON_ATTRIBUTE = "data-approval-primary";

function approvalCardSelector(approvalId: string) {
  return `[${APPROVAL_CARD_ID_ATTRIBUTE}="${approvalId.replace(/["\\]/gu, "\\$&")}"]`;
}

export function PendingApprovalBanner({
  approvals,
  threadRef,
}: {
  approvals: readonly PendingApproval[];
  threadRef: RefObject<HTMLElement | null>;
}) {
  const [offscreenIds, setOffscreenIds] = useState<readonly string[]>([]);
  // The effect reads the rendered thread, so it has to re-run whenever the set of pending
  // approvals changes — but not on every unrelated re-render of a streaming chat.
  const approvalIds = approvals.map((approval) => approval.approvalId).join(" ");

  useEffect(() => {
    const thread = threadRef.current;
    const cards = approvalIds.split(" ").filter(Boolean);
    if (!thread || cards.length === 0 || typeof IntersectionObserver === "undefined") {
      setOffscreenIds([]);
      return;
    }
    const nodes = cards.flatMap((approvalId) => {
      const node = thread.querySelector(approvalCardSelector(approvalId));
      return node ? [node] : [];
    });
    if (nodes.length === 0) {
      setOffscreenIds([]);
      return;
    }
    const hidden = new Set<string>();
    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          const approvalId = record.target.getAttribute(APPROVAL_CARD_ID_ATTRIBUTE);
          if (!approvalId) continue;
          if (record.isIntersecting) hidden.delete(approvalId);
          else hidden.add(approvalId);
        }
        setOffscreenIds(cards.filter((approvalId) => hidden.has(approvalId)));
      },
      { root: thread, threshold: 0.5 },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [approvalIds, threadRef]);

  const offscreen = approvals.filter((approval) => offscreenIds.includes(approval.approvalId));
  const first = offscreen[0];
  if (!first) return null;

  return (
    <button
      type="button"
      data-testid="chat-pending-approval-banner"
      onClick={() => {
        const thread = threadRef.current;
        const card = thread?.querySelector(approvalCardSelector(first.approvalId));
        card?.scrollIntoView({ behavior: "smooth", block: "center" });
        card
          ?.querySelector<HTMLButtonElement>(`[${APPROVAL_PRIMARY_BUTTON_ATTRIBUTE}]`)
          ?.focus({ preventScroll: true });
      }}
      className="flex w-full items-center gap-2 rounded-lg border border-border-strong bg-surface px-3 py-2 text-left shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition-colors hover:bg-surface-hover"
    >
      <ShieldQuestion size={13} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
      <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-ink">
        {offscreen.length > 1
          ? `${offscreen.length} approvals are waiting for you`
          : `${first.source} · ${first.question}`}
      </span>
      <span className="shrink-0 text-[11.5px] font-medium text-ink-muted">Review</span>
    </button>
  );
}
