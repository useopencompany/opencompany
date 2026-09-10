"use client";

import { ArrowLeft, Inbox } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { useAppData } from "@/components/AppDataProvider";
import { Markdown } from "@/components/Markdown";
import { EmptyState, formatRelativeTime } from "@/components/Routes";
import { useHeadlessChatTranscript } from "@/components/useHeadlessChatTranscript";
import { textFromChatUiMessage } from "@/lib/chat-ui";
import { updateHeadlessChatConversation } from "@/lib/headless-chat-commands";
import { groupReviewItems, type ReviewItem } from "@/lib/review-inbox";

export function ReviewInboxRoute() {
  const { reviewItems } = useAppData();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Items opened during this visit. They stay in the list after being marked seen so the queue
  // does not resequence under the cursor mid-pass; leaving the route drops them (this component
  // unmounts with the route, which is exactly the intended lifetime).
  const [heldItems, setHeldItems] = useState<ReadonlyMap<string, ReviewItem>>(new Map());

  const items = useMemo(() => {
    const live = new Map(reviewItems.map((item) => [item.conversationId, item]));
    for (const [conversationId, held] of heldItems) {
      if (!live.has(conversationId)) live.set(conversationId, held);
    }
    // markSeen leaves updated_at untouched (chat-repository only bumps it on archive), so
    // re-sorting here cannot move a row the user just opened.
    return [...live.values()].toSorted(
      (left, right) => timestampMs(right.updatedAt) - timestampMs(left.updatedAt),
    );
  }, [heldItems, reviewItems]);

  const selected = selectedId
    ? (items.find((item) => item.conversationId === selectedId) ?? null)
    : null;

  const select = useCallback((item: ReviewItem) => {
    setSelectedId(item.conversationId);
    setHeldItems((current) => {
      if (current.has(item.conversationId)) return current;
      return new Map(current).set(item.conversationId, item);
    });
    void updateHeadlessChatConversation(item.conversationId, { markSeen: true }).catch(
      (error: unknown) => {
        // The queue is a read surface: a failed markSeen leaves the item unread, which is the
        // safe direction, so surface it in logs rather than blocking the reader with an error.
        console.warn("Could not mark a reviewed conversation as seen.", {
          conversationId: item.conversationId,
          error,
        });
      },
    );
  }, []);

  const groups = useMemo(() => groupReviewItems(items), [items]);

  return (
    <main className="flex h-full min-h-0 w-full overflow-hidden bg-canvas text-ink">
      <div
        className={`h-full w-full min-w-0 flex-col border-border-subtle md:flex md:w-[340px] md:shrink-0 md:border-r ${
          selected ? "hidden" : "flex"
        }`}
      >
        <header className="flex items-center gap-2 px-4 pb-3 pt-5">
          <Inbox size={15} strokeWidth={1.75} className="shrink-0 text-ink-subtle" />
          <h1 className="text-[14px] font-semibold leading-tight tracking-tight text-ink">
            For review
          </h1>
          {items.length > 0 ? (
            <span className="ml-auto text-[12px] tabular-nums leading-none text-ink-subtle">
              {items.length}
            </span>
          ) : null}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
          {groups.length === 0 ? (
            <p className="px-2 py-8 text-center text-[12.5px] leading-5 text-ink-subtle">
              Nothing to review. Finished chats and tasks land here when you haven&apos;t read them
              yet.
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.kind} className="flex flex-col">
                <h2 className="px-2 pb-1 pt-4 text-[11px] font-medium uppercase tracking-[0.07em] text-ink-faint">
                  {group.label}
                </h2>
                {group.items.map((item) => (
                  <ReviewListRow
                    key={item.conversationId}
                    item={item}
                    selected={item.conversationId === selectedId}
                    unread={!heldItems.has(item.conversationId)}
                    onSelect={() => select(item)}
                  />
                ))}
              </section>
            ))
          )}
        </div>
      </div>

      <div className={`min-w-0 flex-1 md:flex ${selected ? "flex" : "hidden"}`}>
        {selected ? (
          <ReviewDetail
            key={selected.conversationId}
            item={selected}
            onBack={() => setSelectedId(null)}
          />
        ) : (
          <div className="flex min-h-0 w-full items-center justify-center overflow-y-auto px-6 py-10">
            <div className="w-full max-w-[520px]">
              <EmptyState
                icon={Inbox}
                title={items.length > 0 ? "Pick something to read" : "You're all caught up"}
                description={
                  items.length > 0
                    ? "Select an item on the left to read the finished result without leaving the queue."
                    : "When a chat reply or task result finishes and you haven't read it, it shows up here."
                }
              />
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function ReviewListRow({
  item,
  selected,
  unread,
  onSelect,
}: {
  item: ReviewItem;
  selected: boolean;
  unread: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
        selected ? "bg-surface-active" : "hover:bg-surface-hover"
      }`}
    >
      <span
        aria-hidden="true"
        data-testid={unread ? "review-item-unread" : "review-item-read"}
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${unread ? "bg-info" : "bg-transparent"}`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] font-medium leading-tight text-ink">
            {item.title}
          </span>
          <span className="ml-auto shrink-0 text-[11.5px] leading-tight text-ink-faint">
            {formatRelativeTime(item.updatedAt)}
          </span>
        </span>
        {item.source.kind === "task" ? (
          <span className="mt-0.5 block truncate text-[11.5px] leading-4 text-ink-subtle">
            {item.source.displayId}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function ReviewDetail({ item, onBack }: { item: ReviewItem; onBack: () => void }) {
  const { messages, isLoading, syncFailed } = useHeadlessChatTranscript(item.conversationId);

  const lastAssistantText = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant") continue;
      const text = textFromChatUiMessage(message).trim();
      if (text) return text;
    }
    return null;
  }, [messages]);

  const openHref =
    item.source.kind === "task"
      ? `/tasks/${encodeURIComponent(item.source.taskId)}`
      : `/chat/${encodeURIComponent(item.conversationId)}`;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="flex items-center gap-3 border-b border-border-subtle px-6 pb-3 pt-5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to the review list"
          className="-ml-2 shrink-0 rounded-md p-1.5 text-ink/60 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 md:hidden"
        >
          <ArrowLeft size={15} strokeWidth={1.75} />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold leading-tight text-ink">
            {item.title}
          </h2>
          <p className="truncate text-[11.5px] leading-4 text-ink-subtle">
            {item.source.kind === "task" ? `${item.source.displayId} · ` : ""}
            {formatRelativeTime(item.updatedAt)}
          </p>
        </div>
        <Link
          href={openHref}
          prefetch
          className="shrink-0 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          {item.source.kind === "task" ? "Open task" : "Open chat"}
        </Link>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <ReviewDetailBody
          isLoading={isLoading}
          syncFailed={syncFailed}
          text={lastAssistantText}
          openHref={openHref}
        />
      </div>
    </div>
  );
}

function ReviewDetailBody({
  isLoading,
  syncFailed,
  text,
  openHref,
}: {
  isLoading: boolean;
  syncFailed: boolean;
  text: string | null;
  openHref: string;
}) {
  if (syncFailed) {
    return (
      <p className="text-[13px] leading-5 text-warning">
        This result could not be loaded.{" "}
        <Link href={openHref} className="underline">
          Open it directly
        </Link>{" "}
        to retry.
      </p>
    );
  }

  if (isLoading && !text) {
    return (
      <div aria-label="Loading result" className="flex flex-col gap-3">
        <div className="h-4 w-2/3 rounded bg-surface-muted" />
        <div className="h-4 w-full rounded bg-surface-muted" />
        <div className="h-4 w-5/6 rounded bg-surface-muted" />
      </div>
    );
  }

  if (!text) {
    return (
      <p className="text-[13px] leading-5 text-ink-subtle">
        This turn finished without a text result.{" "}
        <Link href={openHref} className="underline">
          Open it
        </Link>{" "}
        to see the full run.
      </p>
    );
  }

  return <Markdown content={text} />;
}

function timestampMs(value: string) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}
