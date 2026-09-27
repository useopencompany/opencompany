import { PULL_REQUEST_STATE_LABELS } from "@opencompany/core/pull-requests";
import { useQuery } from "@tanstack/react-query";
import { Link } from "expo-router";
import type { SFSymbol } from "expo-symbols";
import { ActivityIndicator, Linking, Pressable, Text, View } from "react-native";
import type { MarkdownStyle } from "react-native-enriched-markdown";
import { StreamdownText } from "react-native-streamdown";
import { until } from "until-async";
import { analytics, captureError } from "@/shared/lib/analytics";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { chatQueryKeys, useChatCoordinator } from "@/widgets/chat/model/chat-coordinator";
import { useChatInputController } from "@/widgets/chat/model/chat-input-controller";
import { listStoredMessages } from "@/widgets/chat/model/chat-store";
import type { useConversationActions } from "@/widgets/chat/model/conversation-actions";
import type { SessionPullRequest, SidebarItem } from "../model/sidebar-items";

const PULL_REQUEST_SYMBOLS: Record<SessionPullRequest["state"], SFSymbol> = {
  open: "arrow.triangle.pull",
  draft: "pencil.circle",
  blocked: "exclamationmark.circle",
  merged: "arrow.triangle.merge",
  closed: "xmark.circle",
};

const PULL_REQUEST_TINTS: Record<SessionPullRequest["state"], string> = {
  open: "accent-pr-open",
  draft: "accent-pr-draft",
  blocked: "accent-pr-blocked",
  merged: "accent-pr-merged",
  closed: "accent-pr-closed",
};

function PullRequestButton({ pullRequest }: { pullRequest: SessionPullRequest }) {
  const label = `${PULL_REQUEST_STATE_LABELS[pullRequest.state]}, ${pullRequest.repository} number ${pullRequest.number}`;
  return (
    <Pressable
      accessibilityHint="Opens the pull request on GitHub"
      accessibilityLabel={label}
      accessibilityRole="link"
      className="size-9 items-center justify-center rounded-full active:bg-secondary"
      hitSlop={4}
      onPress={() => {
        analytics.capture("pull_request_opened", { state: pullRequest.state });
        void Linking.openURL(pullRequest.url).catch((error: unknown) =>
          captureError("pull_request_open_failed", error),
        );
      }}
    >
      <StyledSymbolView
        name={PULL_REQUEST_SYMBOLS[pullRequest.state]}
        size={16}
        tintColorClassName={PULL_REQUEST_TINTS[pullRequest.state]}
        weight="semibold"
      />
    </Pressable>
  );
}

/**
 * The marker slot before a title follows the run lifecycle, as on web: a live run, then a request
 * waiting on the reader, then an unread result, and only once that result is read, its PR.
 * A settled, read conversation without a PR gets no slot at all.
 */
function RowMarker({ item, pullRequest }: { item: SidebarItem; pullRequest?: SessionPullRequest }) {
  if (item.state === "done_seen") {
    return pullRequest ? <PullRequestButton pullRequest={pullRequest} /> : null;
  }
  return (
    <View className="size-9 items-center justify-center">
      {item.state === "working" ? (
        <ActivityIndicator
          accessibilityLabel="Working"
          colorClassName="accent-warning"
          size="small"
          style={{ transform: [{ scale: 0.7 }] }}
        />
      ) : (
        <View
          accessibilityLabel={item.state === "awaiting_input" ? "Waiting for you" : "Unread"}
          accessible
          className={
            item.state === "awaiting_input"
              ? "size-2 rounded-full bg-warning"
              : "size-2 rounded-full bg-info"
          }
        />
      )}
    </View>
  );
}

const PREVIEW_SIZE = { width: 340, height: 300 };

/**
 * Link.Preview mounts its children only while the preview is open, so the transcript loads when the
 * reader asks for it. Chats and Tasks never opened on this device have no local transcript yet, so
 * opening the preview also syncs it from the server into the local cache.
 */
function ConversationPreview({
  conversation,
  markdownStyle,
  themeKey,
}: {
  conversation: SidebarItem["conversation"];
  markdownStyle: MarkdownStyle;
  themeKey: string;
}) {
  const { partition, refreshConversation } = useChatCoordinator();
  const storedQuery = useQuery({
    queryKey: partition
      ? [...chatQueryKeys.messages(partition, conversation.id), "sidebar-preview"]
      : ["chat", "sidebar-preview", "signed-out"],
    queryFn: () => listStoredMessages(partition!, conversation.id),
    enabled: Boolean(partition),
    staleTime: Infinity,
  });
  const syncQuery = useQuery({
    queryKey: partition
      ? chatQueryKeys.transcriptSync(partition, conversation.id)
      : ["chat", "transcript-sync", "signed-out"],
    queryFn: async ({ signal }) => {
      const [error] = await until(() => refreshConversation(conversation.id, signal));
      if (error) {
        if (!signal.aborted) captureError("sidebar_preview_sync_failed", error);
        throw error;
      }
      return null;
    },
    enabled: Boolean(partition),
    retry: false,
    staleTime: 30_000,
  });
  const assistant = storedQuery.data?.findLast((message) => message.role === "assistant");
  const markdown = assistant
    ? assistant.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ||
      assistant.content
    : "";

  return (
    // The preview container has no size of its own until it appears, so without a fixed size the
    // markdown is measured against an unbounded width, and the text view it then lays out with an
    // infinite width crashes UIKit (CALayerInvalidGeometry).
    <View className="gap-4 bg-background p-5" style={PREVIEW_SIZE}>
      <Text numberOfLines={2} className="text-[19px] font-semibold text-foreground">
        {conversation.title}
      </Text>
      {markdown ? (
        <StreamdownText
          flavor="github"
          key={themeKey}
          markdown={markdown}
          markdownStyle={markdownStyle}
        />
      ) : storedQuery.isPending || syncQuery.isPending ? (
        <View className="flex-row items-center gap-2">
          <ActivityIndicator size="small" colorClassName="accent-muted-foreground" />
          <Text className="text-[15px] text-muted-foreground">Loading the latest reply...</Text>
        </View>
      ) : storedQuery.isError || syncQuery.isError ? (
        <Text className="text-[15px] text-muted-foreground">
          The latest reply could not be loaded.
        </Text>
      ) : (
        <Text className="text-[15px] text-muted-foreground">No replies yet.</Text>
      )}
    </View>
  );
}

export function SidebarConversationRow({
  active,
  actions,
  item,
  markdownStyle,
  pullRequest,
  themeKey,
}: {
  active: boolean;
  actions: ReturnType<typeof useConversationActions>;
  item: SidebarItem;
  markdownStyle: MarkdownStyle;
  pullRequest?: SessionPullRequest;
  themeKey: string;
}) {
  const input = useChatInputController();
  const { conversation } = item;
  const availability = actions.availability(conversation);
  const marked = item.state !== "done_seen" || Boolean(pullRequest);
  const isTask = conversation.kind === "task";
  const hasMenu = !isTask || availability.canArchive;

  return (
    // The marker sits inside the trigger so a long press lifts the whole rounded row. A PR button
    // is its own Pressable, so tapping it opens GitHub rather than the chat.
    <Link asChild href={{ pathname: "/chats/[chatId]", params: { chatId: conversation.id } }}>
      <Link.Trigger>
        <Pressable
          accessibilityHint={isTask ? `Task ${conversation.task?.displayId ?? ""}` : undefined}
          accessibilityState={{ selected: active }}
          className={
            active
              ? "min-h-11 flex-row items-start rounded-xl bg-secondary border-continuous"
              : "min-h-11 flex-row items-start rounded-xl border-continuous active:bg-secondary"
          }
          collapsable={false}
          onPress={() => analytics.capture("conversation_opened", { kind: conversation.kind })}
          onPressIn={() => void input.dismissSearch()}
        >
          {marked ? (
            // Centered on the title's first line, so a Task's number stays aligned under its title.
            <View className="pl-1.5 pt-[4px]">
              <RowMarker item={item} pullRequest={pullRequest} />
            </View>
          ) : null}
          <View className={marked ? "flex-1 py-3 pr-4 pl-1" : "flex-1 px-4 py-3"}>
            <Text numberOfLines={1} className="text-[17px] text-sidebar-foreground leading-[22px]">
              {conversation.title}
            </Text>
            {isTask && conversation.task ? (
              <Text numberOfLines={1} className="text-[13px] text-muted-foreground leading-4">
                {conversation.task.displayId}
              </Text>
            ) : null}
          </View>
        </Pressable>
      </Link.Trigger>
      <Link.Preview style={PREVIEW_SIZE}>
        <ConversationPreview
          conversation={conversation}
          markdownStyle={markdownStyle}
          themeKey={themeKey}
        />
      </Link.Preview>
      {hasMenu ? (
        <Link.Menu>
          {isTask ? null : (
            <Link.MenuAction
              disabled={!availability.canShare}
              icon="square.and.arrow.up"
              onPress={() => actions.share(conversation)}
              title="Share"
            />
          )}
          {isTask ? null : (
            <Link.MenuAction
              disabled={!availability.canPin}
              icon={availability.isPinned ? "pin.slash" : "pin"}
              onPress={() => actions.togglePin(conversation)}
              title={availability.isPinned ? "Unpin" : "Pin"}
            />
          )}
          <Link.MenuAction
            disabled={!availability.canArchive}
            icon="archivebox"
            onPress={() => actions.archive(conversation)}
            title="Archive"
          />
        </Link.Menu>
      ) : null}
    </Link>
  );
}
