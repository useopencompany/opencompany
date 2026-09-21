import type { ResolveApprovalBody } from "@opencompany/protocol/schemas";
import { useMutation } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Share, Text, View } from "react-native";
import type { MarkdownStyle } from "react-native-enriched-markdown";
import { StreamdownText } from "react-native-streamdown";
import { StyledImage } from "@/shared/ui/styled-image";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { useToast } from "@/shared/ui/toast";
import type { ApprovalPart, ChatMessage as ChatMessageModel, ChatPart } from "../model/chat";
import { ShimmerText } from "./ShimmerText";

const SHARE_SPINNER_DELAY_MS = 140;
const COPY_CONFIRMATION_DURATION_MS = 2000;

function orderedMessageParts(message: ChatMessageModel, text: string): ChatPart[] {
  if (message.parts.length > 0) return message.parts;
  if (!text) return [];
  return [{ id: `text:${message.id}:fallback`, type: "text", text }];
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

function GenericPart({
  part,
  onApproval,
}: {
  part: Exclude<ChatPart, { type: "text" }>;
  onApproval: (approvalId: string, body: ResolveApprovalBody) => Promise<void>;
}) {
  if (part.type === "attachment") return <AttachmentRow part={part} />;
  if (part.type === "approval") return <ApprovalCard part={part} onApproval={onApproval} />;
  if (part.type === "tool") {
    return (
      <View className="rounded-xl border-continuous bg-secondary px-3 py-2">
        <Text selectable className="text-[14px] font-medium text-secondary-foreground">
          {part.label ?? part.name} · {part.status}
        </Text>
        {(part.detail ?? part.summary ?? part.error) ? (
          <Text selectable className="pt-1 text-[13px] leading-5 text-muted-foreground">
            {part.detail ?? part.summary ?? part.error}
          </Text>
        ) : null}
      </View>
    );
  }
  if (part.type === "artifact") {
    return (
      <View className="rounded-xl border-continuous bg-secondary px-3 py-2">
        <Text selectable className="text-[14px] font-medium text-secondary-foreground">
          {part.title}
        </Text>
        <Text selectable className="pt-1 text-[12px] text-muted-foreground">
          {part.filename}
        </Text>
      </View>
    );
  }
  return (
    <Text selectable className="text-[13px] text-muted-foreground italic">
      {part.message}
    </Text>
  );
}

export function ChatMessage({
  isTerminal,
  message,
  markdownStyle,
  onApproval,
  onLinkPress,
  themeKey,
}: {
  isTerminal: boolean;
  message: ChatMessageModel;
  markdownStyle: MarkdownStyle;
  onApproval: (approvalId: string, body: ResolveApprovalBody) => Promise<void>;
  onLinkPress: (url: string) => void;
  themeKey: string;
}) {
  const { showErrorToast, showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nonTextParts = message.parts.filter(
    (part): part is Exclude<ChatPart, { type: "text" }> => part.type !== "text",
  );
  const text =
    message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") ||
    message.content;
  const orderedParts = orderedMessageParts(message, text);
  const displayedParts = orderedParts.filter(
    (part) => part.type !== "notice" || part.kind === "error" || (isTerminal && !text),
  );
  const copyMutation = useMutation({
    mutationFn: () => Clipboard.setStringAsync(text),
    onSuccess: () => {
      setCopied(true);
      showToast("Copied to clipboard", { duration: COPY_CONFIRMATION_DURATION_MS });
      if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current);
      copyResetTimeoutRef.current = setTimeout(() => {
        copyResetTimeoutRef.current = null;
        setCopied(false);
      }, COPY_CONFIRMATION_DURATION_MS);
    },
    onError: (error) => showErrorToast("The response could not be copied.", error, "chat.copy"),
  });
  const shareMutation = useMutation({
    mutationFn: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, SHARE_SPINNER_DELAY_MS));
      return Share.share({ message: text });
    },
    onError: (error) => showErrorToast("The response could not be shared.", error, "chat.share"),
  });

  useEffect(
    () => () => {
      if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current);
    },
    [],
  );

  if (message.role === "user") {
    return (
      <View className="mb-[22px] max-w-[82%] self-end gap-2">
        {message.content ? (
          <View className="rounded-[20px] border-continuous bg-primary px-4 py-[11px]">
            <Text selectable className="text-[16px] text-primary-foreground leading-[22px]">
              {message.content}
            </Text>
          </View>
        ) : null}
        {nonTextParts.map((part) => (
          <GenericPart key={part.id} part={part} onApproval={onApproval} />
        ))}
      </View>
    );
  }

  return (
    <View className="mb-[22px] min-w-full self-stretch gap-3">
      {displayedParts.length ? (
        displayedParts.map((part) =>
          part.type === "text" ? (
            <StreamdownText
              flavor="github"
              key={`${themeKey}:${part.id}`}
              markdown={part.text}
              markdownStyle={markdownStyle}
              onLinkPress={(event) => onLinkPress(event.url)}
            />
          ) : (
            <GenericPart key={part.id} part={part} onApproval={onApproval} />
          ),
        )
      ) : !isTerminal ? (
        <View
          accessibilityLabel="Assistant is thinking"
          className="min-h-[30px] flex-row items-center gap-2"
        >
          <StyledSymbolView
            name="sparkles"
            size={15}
            tintColorClassName="accent-muted-foreground"
          />
          <ShimmerText text="Thinking" width={112} />
        </View>
      ) : null}
      {isTerminal && text ? (
        <View className="flex-row items-center gap-2 pt-0.5">
          <Pressable
            accessibilityLabel="Copy response"
            accessibilityRole="button"
            className="size-8 items-center justify-center active:opacity-50"
            disabled={copyMutation.isPending}
            hitSlop={6}
            onPress={() => copyMutation.mutate()}
          >
            <StyledSymbolView
              name={copied ? "checkmark" : "doc.on.doc"}
              size={17}
              tintColorClassName="accent-muted-foreground"
            />
          </Pressable>
          <Pressable
            accessibilityLabel="Share response"
            accessibilityRole="button"
            className="size-8 items-center justify-center active:opacity-50"
            disabled={shareMutation.isPending}
            hitSlop={6}
            onPress={() => shareMutation.mutate()}
          >
            {shareMutation.isPending ? (
              <ActivityIndicator size="small" colorClassName="accent-muted-foreground" />
            ) : (
              <StyledSymbolView
                name="square.and.arrow.up"
                size={17}
                tintColorClassName="accent-muted-foreground"
              />
            )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
