import type { ResolveApprovalBody } from "@opencompany/protocol/schemas";
import { type ReactNode, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { MarkdownStyle } from "react-native-enriched-markdown";
import { StreamdownText } from "react-native-streamdown";
import { StackLoader } from "@/shared/ui/stack-loader";
import { StyledImage } from "@/shared/ui/styled-image";
import { type ActivityItem, activityItems, compactActivity } from "../model/activity-items";
import type {
  ApprovalPart,
  ChatMessage as ChatMessageModel,
  ChatPart,
  ReasoningPart,
  ToolPart,
} from "../model/chat";
import { referenceLabelRanges } from "../model/quick-actions/composer-segments";
import { NestedTrace, ReasoningRow, ToolCard, TraceDisclosure } from "./activity-rows";
import { AssistantMessageActions } from "./assistant-message-actions";

function orderedMessageParts(message: ChatMessageModel, text: string): ChatPart[] {
  if (message.parts.length > 0) return message.parts;
  if (!text) return [];
  return [{ id: `text:${message.id}:fallback`, type: "text", text }];
}

/** A sent message shows plugin and repository mentions as their labels, not as Markdown links. */
function formatUserMessageText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const range of referenceLabelRanges(text)) {
    if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
    nodes.push(
      <Text className="font-medium text-accent" key={range.start}>
        {range.label}
      </Text>,
    );
    cursor = range.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function AttachmentRow({ part }: { part: Extract<ChatPart, { type: "attachment" }> }) {
  if (part.localUri && part.attachment.kind === "image") {
    return (
      <StyledImage
        accessibilityLabel={part.attachment.filename}
        className="size-40 rounded-[16px] border-continuous bg-secondary"
        contentFit="cover"
        source={{ uri: part.localUri }}
      />
    );
  }
  return (
    <View className="self-start rounded-xl border-continuous bg-secondary px-3 py-2">
      <Text selectable className="text-[14px] font-medium text-secondary-foreground">
        {part.attachment.filename}
      </Text>
      <Text className="text-[12px] text-muted-foreground">
        {(part.attachment.sizeBytes / 1024).toFixed(0)} KB
      </Text>
    </View>
  );
}

function ApprovalCard({
  part,
  onApproval,
}: {
  part: ApprovalPart;
  onApproval: (approvalId: string, body: ResolveApprovalBody) => Promise<void>;
}) {
  const disabled = part.status !== "pending";
  return (
    <View className="gap-3 rounded-[16px] border-continuous bg-secondary px-4 py-3">
      <Text selectable className="text-[15px] font-semibold text-secondary-foreground">
        Approval needed
      </Text>
      <Text selectable className="text-[14px] leading-5 text-muted-foreground">
        {part.prompt}
      </Text>
      {part.input ? (
        <Text selectable className="font-mono text-[12px] leading-4 text-muted-foreground">
          {JSON.stringify(part.input, null, 2)}
        </Text>
      ) : null}
      {part.options.map((option) => (
        <Pressable
          accessibilityRole="button"
          className="rounded-lg bg-background px-3 py-2 active:opacity-60"
          disabled={disabled}
          key={option}
          onPress={() =>
            void onApproval(part.approvalId, { resolution: "answered", answer: option })
          }
        >
          <Text className="text-center text-[14px] font-medium text-foreground">{option}</Text>
        </Pressable>
      ))}
      <View className="flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          className="flex-1 rounded-lg bg-accent px-3 py-2 active:opacity-60"
          disabled={disabled}
          onPress={() => void onApproval(part.approvalId, { resolution: "approved" })}
        >
          <Text className="text-center text-[14px] font-semibold text-accent-foreground">
            Approve
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          className="flex-1 rounded-lg bg-background px-3 py-2 active:opacity-60"
          disabled={disabled}
          onPress={() => void onApproval(part.approvalId, { resolution: "denied" })}
        >
          <Text className="text-center text-[14px] font-semibold text-foreground">Deny</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          className="flex-1 rounded-lg bg-background px-3 py-2 active:opacity-60"
          disabled={disabled}
          onPress={() => void onApproval(part.approvalId, { resolution: "canceled" })}
        >
          <Text className="text-center text-[14px] font-semibold text-foreground">Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ActivityItemView({
  item,
  markdownStyle,
  onApproval,
  onLinkPress,
  onOpenPart,
  themeKey,
}: {
  item: ActivityItem;
  markdownStyle: MarkdownStyle;
  onApproval: (approvalId: string, body: ResolveApprovalBody) => Promise<void>;
  onLinkPress: (url: string) => void;
  onOpenPart: (part: ToolPart | ReasoningPart) => void;
  themeKey: string;
}): ReactNode {
  switch (item.type) {
    case "text":
      return (
        <StreamdownText
          flavor="github"
          markdown={item.text}
          markdownStyle={markdownStyle}
          onLinkPress={(event) => onLinkPress(event.url)}
          key={`${themeKey}:${item.key}`}
        />
      );
    case "reasoning":
      return <ReasoningRow part={item.part} onPress={() => onOpenPart(item.part)} />;
    case "steering":
      return (
        <View className="max-w-[82%] self-end rounded-[20px] border-continuous border border-border px-4 py-[9px]">
          <Text selectable className="text-[15px] leading-[21px] text-muted-foreground">
            {item.part.text}
          </Text>
        </View>
      );
    case "tool":
      return (
        <View className="gap-2.5">
          <ToolCard part={item.part} onPress={() => onOpenPart(item.part)} />
          {item.children.length > 0 ? (
            <NestedTrace>
              {item.children.map((child) => (
                <ActivityItemView
                  item={child}
                  key={child.key}
                  markdownStyle={markdownStyle}
                  onApproval={onApproval}
                  onLinkPress={onLinkPress}
                  onOpenPart={onOpenPart}
                  themeKey={themeKey}
                />
              ))}
            </NestedTrace>
          ) : null}
        </View>
      );
    case "approval":
      return <ApprovalCard part={item.part} onApproval={onApproval} />;
    case "attachment":
      return <AttachmentRow part={item.part} />;
    case "artifact":
      return (
        <View className="rounded-xl border-continuous bg-secondary px-3 py-2">
          <Text selectable className="text-[14px] font-medium text-secondary-foreground">
            {item.part.title}
          </Text>
          <Text selectable className="pt-1 text-[12px] text-muted-foreground">
            {item.part.filename}
          </Text>
        </View>
      );
    case "notice":
      return (
        <Text selectable className="text-[13px] text-muted-foreground italic">
          {item.part.message}
        </Text>
      );
  }
}

export function ChatMessage({
  isTerminal,
  isSending = false,
  isWorking = false,
  message,
  markdownStyle,
  onApproval,
  onLinkPress,
  onOpenPart,
  onToggleTrace,
  themeKey,
  traceExpanded,
}: {
  isTerminal: boolean;
  isSending?: boolean;
  /** The Run is executing this reply, so the working indicator shows beneath it. */
  isWorking?: boolean;
  message: ChatMessageModel;
  markdownStyle: MarkdownStyle;
  onApproval: (approvalId: string, body: ResolveApprovalBody) => Promise<void>;
  onLinkPress: (url: string) => void;
  onOpenPart: (part: ToolPart | ReasoningPart) => void;
  onToggleTrace: () => void;
  themeKey: string;
  traceExpanded: boolean;
}) {
  const [wasActive, setWasActive] = useState(!isTerminal);
  useEffect(() => {
    if (!isTerminal) setWasActive(true);
  }, [isTerminal]);
  const text =
    message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ||
    message.content;
  if (message.role === "user") {
    return (
      <View className="mb-[22px] max-w-[82%] self-end gap-2">
        {message.content ? (
          <View className="rounded-[20px] border-continuous bg-primary px-4 py-[11px]">
            <Text selectable className="text-[16px] text-primary-foreground leading-[22px]">
              {formatUserMessageText(message.content)}
            </Text>
          </View>
        ) : null}
        {message.parts.flatMap((part) =>
          part.type === "attachment" ? [<AttachmentRow key={part.id} part={part} />] : [],
        )}
      </View>
    );
  }

  const items = activityItems(orderedMessageParts(message, text), {
    settled: isTerminal,
    keepEmptyNotices: isTerminal && !text,
  });
  // A resting turn folds its trace behind a disclosure; an active one shows everything.
  const compacted = isTerminal ? compactActivity(items) : null;
  const renderItem = (item: ActivityItem) => (
    <ActivityItemView
      item={item}
      key={item.key}
      markdownStyle={markdownStyle}
      onApproval={onApproval}
      onLinkPress={onLinkPress}
      onOpenPart={onOpenPart}
      themeKey={themeKey}
    />
  );

  return (
    <View className="mb-[22px] min-w-full self-stretch gap-1">
      <View className="gap-3">
        {compacted ? (
          <>
            <TraceDisclosure
              expanded={traceExpanded}
              onToggle={onToggleTrace}
              summary={compacted.summary}
            />
            {traceExpanded ? <NestedTrace>{compacted.hidden.map(renderItem)}</NestedTrace> : null}
            {compacted.visible.map(renderItem)}
          </>
        ) : (
          items.map(renderItem)
        )}
        {isSending && items.length === 0 ? (
          <View accessibilityLabel="Sending message" className="min-h-[30px] flex-row items-center">
            <ActivityIndicator size="small" colorClassName="accent-muted-foreground" />
          </View>
        ) : isWorking ? (
          <View className="min-h-[30px] justify-center">
            <StackLoader />
          </View>
        ) : null}
      </View>
      {isTerminal && text ? (
        <AssistantMessageActions animateOnMount={wasActive} text={text} />
      ) : null}
    </View>
  );
}
