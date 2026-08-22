import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Reanimated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";

import { StyledImage } from "@/shared/ui/styled-image";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import type { ComposerAttachment } from "../model/chat-composer-context";

const ATTACHMENT_ANIMATION_DURATION = 220;

const getFilePresentation = (attachment: ComposerAttachment) => {
  const extensionSeparatorIndex = attachment.name.lastIndexOf(".");
  const hasExtension =
    extensionSeparatorIndex > 0 && extensionSeparatorIndex < attachment.name.length - 1;

  if (hasExtension) {
    return {
      format: attachment.name.slice(extensionSeparatorIndex + 1).toUpperCase(),
      name: attachment.name.slice(0, extensionSeparatorIndex),
    };
  }

  return {
    format: attachment.mimeType?.split("/").at(-1)?.toUpperCase() ?? "FILE",
    name: attachment.name,
  };
};

function AttachmentPreview({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment;
  onRemove: (id: string) => void;
}) {
  const filePresentation = getFilePresentation(attachment);

  return (
    <View className="relative h-28 w-28 overflow-hidden rounded-[16px] border-continuous bg-secondary">
      {attachment.kind === "image" ? (
        <StyledImage
          accessibilityLabel={attachment.name}
          className="h-full w-full"
          contentFit="cover"
          source={{ uri: attachment.uri }}
          transition={120}
        />
      ) : (
        <View className="h-full w-full gap-2 px-3 py-3">
          <Text className="pr-6 text-[14px] text-muted-foreground uppercase leading-[18px]">
            {filePresentation.format}
          </Text>
          <Text
            className="font-medium text-[16px] text-secondary-foreground leading-[20px] tracking-[-0.2px]"
            numberOfLines={3}
          >
            {filePresentation.name}
          </Text>
        </View>
      )}

      <Pressable
        accessibilityLabel={`Remove ${attachment.name}`}
        accessibilityRole="button"
        className={
          attachment.kind === "image"
            ? "absolute top-1.5 right-1.5 h-[24px] w-[24px] items-center justify-center rounded-full bg-black/55 active:opacity-60"
            : "absolute top-1.5 right-1.5 h-[24px] w-[24px] items-center justify-center active:opacity-60"
        }
        hitSlop={8}
        onPress={() => onRemove(attachment.id)}
      >
        <StyledSymbolView
          name="xmark"
          size={attachment.kind === "image" ? 11 : 14}
          tintColorClassName={
            attachment.kind === "image" ? "accent-white" : "accent-secondary-foreground"
          }
          weight="bold"
        />
      </Pressable>
    </View>
  );
}

export function ComposerAttachments({
  attachments,
  contentWidth,
  onRemove,
}: {
  attachments: ComposerAttachment[];
  contentWidth: number;
  onRemove: (id: string) => void;
}) {
  const hasAttachments = attachments.length > 0;
  const [contentHeight, setContentHeight] = useState(0);
  const [displayedAttachments, setDisplayedAttachments] = useState(attachments);
  const unmountTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasDisplayedAttachments = displayedAttachments.length > 0;

  useEffect(() => {
    if (unmountTimeoutRef.current !== null) {
      clearTimeout(unmountTimeoutRef.current);
      unmountTimeoutRef.current = null;
    }

    if (hasAttachments) {
      setDisplayedAttachments(attachments);
      return;
    }

    unmountTimeoutRef.current = setTimeout(() => {
      unmountTimeoutRef.current = null;
      setDisplayedAttachments([]);
    }, ATTACHMENT_ANIMATION_DURATION);

    return () => {
      if (unmountTimeoutRef.current !== null) {
        clearTimeout(unmountTimeoutRef.current);
        unmountTimeoutRef.current = null;
      }
    };
  }, [attachments, hasAttachments]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: withTiming(hasAttachments ? contentHeight : 0, {
      duration: ATTACHMENT_ANIMATION_DURATION,
      easing: Easing.inOut(Easing.ease),
      reduceMotion: ReduceMotion.System,
    }),
    opacity: withTiming(hasAttachments ? 1 : 0, {
      duration: ATTACHMENT_ANIMATION_DURATION,
      easing: Easing.inOut(Easing.ease),
      reduceMotion: ReduceMotion.System,
    }),
  }));

  return (
    <Reanimated.View
      className="overflow-hidden"
      pointerEvents={hasAttachments ? "auto" : "none"}
      style={[animatedStyle, { width: hasDisplayedAttachments ? contentWidth : 0 }]}
    >
      <View
        className="h-[120px] w-full pb-2"
        onLayout={(event) => {
          const nextHeight = Math.ceil(event.nativeEvent.layout.height);
          setContentHeight((currentHeight) =>
            Math.abs(currentHeight - nextHeight) <= 1 ? currentHeight : nextHeight,
          );
        }}
      >
        <ScrollView
          className="h-28"
          contentContainerClassName="flex-row gap-2"
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
        >
          {displayedAttachments.map((attachment) => (
            <AttachmentPreview attachment={attachment} key={attachment.id} onRemove={onRemove} />
          ))}
        </ScrollView>
      </View>
    </Reanimated.View>
  );
}
