"use client";

import type { ChatEngine } from "@opencompany/core";
import { ArrowLeft, Inbox } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "@/components/AppDataProvider";
import { EmptyState, formatRelativeTime } from "@/components/Routes";
import { Surface } from "@/components/Surface";
import { TaskDetailPanel } from "@/components/TaskDetailPanel";
import { useHeadlessChatTranscript } from "@/components/useHeadlessChatTranscript";
import { useTaskRun } from "@/components/useTaskRun";
import type { ChatSessionView } from "@/lib/chat-ui";
import { updateHeadlessChatConversation } from "@/lib/headless-chat-commands";
import { markHeadlessTaskSeen } from "@/lib/headless-task-commands";
import { DEFAULT_MODEL, normalizeConversationModel } from "@/lib/model-options";
import type { ReviewItem } from "@/lib/review-inbox";

export function ReviewInboxRoute() {
  const { reviewItems, workspace } = useAppData();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Items opened during this visit. They stay in the list after being marked seen so the queue
  // does not resequence under the cursor mid-pass; leaving the route drops them (this component
  // unmounts with the route, which is exactly the intended lifetime).
  const [heldItems, setHeldItems] = useState<ReadonlyMap<string, ReviewItem>>(new Map());
  const [readItems, setReadItems] = useState<ReadonlySet<string>>(new Set());
  // Acknowledgment is fire-and-forget and the detail pane can report readability more than once
  // (Electric redelivers rows). This keeps one command in flight per conversation.
  const acknowledging = useRef(new Set<string>());

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
  }, []);

  // Selecting an item is not the same as having read it. The detail pane calls this once the
  // conversation has actually rendered, so a transcript that never loads keeps its unread state
  // instead of being silently cleared on click.
  const acknowledge = useCallback(
    (item: ReviewItem) => {
      const { conversationId } = item;
      if (acknowledging.current.has(conversationId)) return;
      acknowledging.current.add(conversationId);
      const acknowledged =
        item.source.kind === "task"
          ? markHeadlessTaskSeen(item.source.taskId, { scopeKey: workspace.id })
          : updateHeadlessChatConversation(conversationId, { markSeen: true });
      void acknowledged
        .then(() => {
          setReadItems((current) => new Set(current).add(conversationId));
        })
        .catch((error: unknown) => {
          // The queue is a read surface: a failed acknowledgment leaves the item unread, which is
          // the safe direction, so surface it in logs rather than blocking the reader with an
          // error. Clearing the guard lets a later visit retry.
          acknowledging.current.delete(conversationId);
          console.warn("Could not mark a reviewed item as seen.", { conversationId, error });
        });
    },
    [workspace.id],
  );

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
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6 pt-1">
          {items.length === 0 ? (
            <p className="px-2 py-8 text-center text-[12.5px] leading-5 text-ink-subtle">
              Nothing to review. Finished chats and tasks land here when you haven&apos;t read them
              yet.
            </p>
          ) : (
            items.map((item) => (
              <ReviewListRow
                key={item.conversationId}
                item={item}
                selected={item.conversationId === selectedId}
                unread={!readItems.has(item.conversationId)}
                onSelect={() => select(item)}
              />
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
            onRead={acknowledge}
          />
        ) : (
          <div className="flex min-h-0 w-full items-center justify-center overflow-y-auto px-6 py-10">
            <div className="w-full max-w-[520px]">
              <EmptyState
                icon={Inbox}
                title={items.length > 0 ? "Pick something to read" : "You're all caught up"}
                description={
                  items.length > 0
                    ? "Select an item on the left to pick the conversation up where it stopped."
                    : "When a chat or task finishes and you haven't read it, it shows up here."
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

/**
 * The reader opens the live conversation, not a summary of it: the same thread and composer the
 * chat and Task routes render, so answering an approval or continuing the work never means
 * leaving the queue first.
 */
function ReviewDetail({
  item,
  onBack,
  onRead,
}: {
  item: ReviewItem;
  onBack: () => void;
  onRead: (item: ReviewItem) => void;
}) {
  const { messages, isLoading, syncFailed } = useHeadlessChatTranscript(item.conversationId);
  // Acknowledge only what actually rendered. An empty transcript is not proof of an empty result,
  // so it stays unread rather than being cleared on a sync that has not delivered rows yet.
  const readable = !isLoading && !syncFailed && messages.length > 0;

  useEffect(() => {
    if (!readable) return;
    onRead(item);
  }, [item, onRead, readable]);

  const source = item.source;
  const openHref =
    source.kind === "task"
      ? `/tasks/${encodeURIComponent(source.taskId)}`
      : `/chat/${encodeURIComponent(item.conversationId)}`;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="flex items-center gap-3 px-4 pt-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to the review list"
          className="-ml-2 shrink-0 rounded-md p-1.5 text-ink/60 transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 md:hidden"
        >
          <ArrowLeft size={15} strokeWidth={1.75} />
        </button>
        <Link
          href={openHref}
          prefetch
          className="ml-auto shrink-0 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        >
          {source.kind === "task" ? "Open task" : "Open chat"}
        </Link>
      </header>
      {source.kind === "task" ? (
        <ReviewTaskConversation taskId={source.taskId} onClose={onBack} />
      ) : (
        <ReviewChatConversation
          conversationId={item.conversationId}
          title={item.title}
          model={source.model}
          engine={source.engine}
          updatedAt={item.updatedAt}
          onClose={onBack}
        />
      )}
    </div>
  );
}

function ReviewChatConversation({
  conversationId,
  title,
  model,
  engine,
  updatedAt,
  onClose,
}: {
  conversationId: string;
  title: string;
  model: string;
  engine: ChatEngine;
  updatedAt: string;
  onClose: () => void;
}) {
  const data = useAppData();
  const userName = data.user.firstName?.trim() || data.user.email.split("@")[0] || "there";
  // The sidebar list is bounded by recency, so an older unread chat is missing from it. The queue
  // item carries everything needed to open the conversation; the summary only sharpens it.
  const summary = data.recentChats.find((chat) => chat.id === conversationId) ?? null;
  const conversationEngine = summary?.engine ?? engine;
  const initialChat = useMemo<ChatSessionView>(
    () => ({
      id: conversationId,
      title: summary?.title ?? title,
      // A Codex or Claude Code conversation runs on that engine's own model ids, which the
      // opencompany catalog does not contain: normalizing without the engine would silently
      // rewrite the model the composer sends.
      model: normalizeConversationModel(conversationEngine, summary?.model ?? model),
      engine: conversationEngine,
      codexComposerSettings: summary?.codexComposerSettings ?? null,
      // Detail controls wait for the conversation-scoped record instead of trusting a list row.
      runtime: null,
      updatedAt: summary?.updatedAt ?? updatedAt,
      messages: [],
    }),
    [conversationEngine, conversationId, model, summary, title, updatedAt],
  );

  return (
    <Surface
      key={data.activeBrain?.id ?? "no-brain"}
      tasks={data.tasks}
      allTasks={data.allTasks}
      schedules={data.schedules}
      defaultModel={DEFAULT_MODEL}
      initialChat={initialChat}
      recentChats={data.recentChats}
      archivedChats={data.archivedChats}
      codexConnected={data.codexConnected}
      claudeCodeConnected={data.claudeCodeConnected}
      taskSpawningEnabled={data.featureFlags.taskSpawning}
      autoModelRoutingEnabled={data.featureFlags.autoModelRouting}
      workspaceId={data.workspace.id}
      userName={userName}
      userWorkosId={data.user.workosUserId}
      // Closing this pane returns to the list rather than navigating home and cancelling a run
      // that is still going; the queue, not the chat route, is where the reader came from.
      onClosePane={onClose}
    />
  );
}

function ReviewTaskConversation({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const run = useTaskRun(taskId);
  if (!run) {
    return (
      <div aria-label="Loading conversation" className="flex flex-col gap-3 px-6 py-5">
        <div className="h-4 w-2/3 rounded bg-surface-muted" />
        <div className="h-4 w-full rounded bg-surface-muted" />
        <div className="h-4 w-5/6 rounded bg-surface-muted" />
      </div>
    );
  }
  return <TaskDetailPanel initialRun={run} onClosePane={onClose} />;
}

function timestampMs(value: string) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}
