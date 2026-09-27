import { Host } from "@expo/ui";
import { Button, HStack, Label } from "@expo/ui/swift-ui";
import {
  buttonBorderShape,
  buttonStyle,
  controlSize,
  disabled,
  frame,
  labelStyle,
} from "@expo/ui/swift-ui/modifiers";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import type { SFSymbol } from "expo-symbols";
import { ActivityIndicator, Alert, Pressable, Share, Text, View } from "react-native";
import { until } from "until-async";
import { useAuth } from "@/features/auth";
import { publicShareUrl } from "@/shared/api/opencompany-api";
import { analytics, captureError } from "@/shared/lib/analytics";
import { queryClient } from "@/shared/lib/query-client";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { useToast } from "@/shared/ui/toast";
import { chatQueryKeys, useChatCoordinator } from "../model/chat-coordinator";
import { listStoredConversations } from "../model/chat-store";

function AccessOption({
  detail,
  icon,
  isDisabled,
  onPress,
  pending,
  selected,
  title,
}: {
  detail: string;
  icon: SFSymbol;
  isDisabled: boolean;
  onPress: () => void;
  pending: boolean;
  selected: boolean;
  title: string;
}) {
  return (
    <Pressable
      accessibilityHint={detail}
      accessibilityLabel={title}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: isDisabled, busy: pending }}
      className={
        isDisabled && !pending
          ? "flex-row items-center gap-3 px-4 py-3 opacity-50"
          : "flex-row items-center gap-3 px-4 py-3 active:bg-muted"
      }
      disabled={isDisabled}
      onPress={onPress}
    >
      <View className="size-7 items-center justify-center">
        <StyledSymbolView
          accessibilityElementsHidden
          name={icon}
          size={19}
          tintColorClassName="accent-foreground"
        />
      </View>
      <View className="flex-1 gap-0.5">
        <Text className="text-[17px] leading-[22px] text-foreground">{title}</Text>
        <Text className="text-[13px] leading-[18px] text-muted-foreground">{detail}</Text>
      </View>
      <View className="size-6 items-center justify-center">
        {pending ? (
          <ActivityIndicator colorClassName="accent-muted-foreground" size="small" />
        ) : selected ? (
          <StyledSymbolView
            name="checkmark"
            size={16}
            tintColorClassName="accent-link"
            weight="semibold"
          />
        ) : null}
      </View>
    </Pressable>
  );
}

export default function ShareSheet() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { api } = useAuth();
  const { partition, connectivity } = useChatCoordinator();
  const { showToast, showErrorToast } = useToast();
  const online = connectivity !== "offline";
  const conversationQuery = useQuery({
    queryKey: partition
      ? chatQueryKeys.conversations(partition)
      : ["chat", "conversations", "signed-out"],
    queryFn: () => listStoredConversations(partition!),
    enabled: Boolean(partition),
    select: (items) => items.find((item) => item.id === conversationId),
  });
  const shareKey = ["chat", partition?.userId, partition?.workspaceId, "share", conversationId];
  // Reading the status never publishes anything. A link exists only once the reader picks
  // "Anyone with the link" or asks to copy or share it.
  const shareQuery = useQuery({
    queryKey: shareKey,
    queryFn: async ({ signal }) =>
      (await api.getConversationShare(conversationId, signal)).data.shareId,
    enabled: Boolean(partition) && online,
    retry: false,
  });
  const shareId = shareQuery.data ?? null;
  const shareUrl = shareId ? publicShareUrl(shareId) : null;

  const createMutation = useMutation({
    mutationFn: async () =>
      (await api.createConversationShare(conversationId, partition?.signal)).data.shareId,
    onSuccess: (createdShareId) => {
      queryClient.setQueryData(shareKey, createdShareId);
      analytics.capture("conversation_share_created");
    },
    onError: (error) => showErrorToast("The share link could not be created.", error, "chat.share"),
  });
  const revokeMutation = useMutation({
    mutationFn: () => api.deleteConversationShare(conversationId, partition?.signal),
    onSuccess: () => {
      queryClient.setQueryData(shareKey, null);
      analytics.capture("conversation_share_revoked");
      showToast("Sharing is off. The old link no longer works.");
    },
    onError: (error) => showErrorToast("Sharing could not be stopped.", error, "chat.share.revoke"),
  });
  const busy = createMutation.isPending || revokeMutation.isPending;
  const ready = online && shareQuery.isSuccess;

  // Copy and Share publish the chat first when it is still private: asking for the link is the
  // reader's intent to share it.
  const resolveShareUrl = async (): Promise<string | null> => {
    if (shareUrl) return shareUrl;
    const [error, createdShareId] = await until(() => createMutation.mutateAsync());
    return error || !createdShareId ? null : publicShareUrl(createdShareId);
  };

  const copy = async () => {
    if (busy) return;
    const url = await resolveShareUrl();
    if (!url) return;
    const [error] = await until(() => Clipboard.setStringAsync(url));
    if (error) {
      showErrorToast("The link could not be copied.", error, "chat.share.copy");
      return;
    }
    analytics.capture("share_link_copied");
    showToast("Link copied");
  };

  const share = async () => {
    if (busy) return;
    const url = await resolveShareUrl();
    if (!url) return;
    const [error, result] = await until(() => Share.share({ url }));
    if (error) captureError("share_link_share_failed", error);
    else if (result.action === Share.sharedAction) analytics.capture("share_link_shared");
  };

  const makePrivate = () => {
    if (!shareUrl || busy) return;
    Alert.alert(
      "Stop Sharing?",
      "The current link stops working immediately. You can create a new link at any time.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Stop Sharing", style: "destructive", onPress: () => revokeMutation.mutate() },
      ],
    );
  };

  return (
    // The sheet sizes itself to this content, so the title and close button live here rather than
    // in a native header: a transparent header's inset isn't counted, which leaves the bottom
    // buttons outside the sheet's touch area.
    <View className="gap-6 bg-background px-5 pt-4 pb-8">
      <View className="h-11 items-center justify-center">
        <Text accessibilityRole="header" className="text-[17px] font-semibold text-foreground">
          Share Chat
        </Text>
        <View className="absolute right-0">
          <Host matchContents>
            <Button
              label="Close"
              systemImage="xmark"
              onPress={() => router.dismiss()}
              modifiers={[
                buttonStyle("glass"),
                buttonBorderShape("circle"),
                controlSize("large"),
                labelStyle("iconOnly"),
              ]}
            />
          </Host>
        </View>
      </View>

      <View className="flex-row items-center gap-3 rounded-2xl bg-secondary px-4 py-3.5 border-continuous">
        <StyledSymbolView
          accessibilityElementsHidden
          name="bubble.left"
          size={18}
          tintColorClassName="accent-muted-foreground"
        />
        <Text numberOfLines={2} className="flex-1 text-[17px] leading-[22px] text-foreground">
          {conversationQuery.data?.title ?? "Chat"}
        </Text>
      </View>

      <View className="gap-2">
        <View className="flex-row items-center gap-2 px-4">
          <Text className="text-[13px] font-semibold text-muted-foreground">Who can view</Text>
          {online && shareQuery.isPending ? (
            <ActivityIndicator
              accessibilityLabel="Loading sharing settings"
              colorClassName="accent-muted-foreground"
              size="small"
            />
          ) : null}
        </View>
        <View className="overflow-hidden rounded-2xl bg-secondary border-continuous">
          <AccessOption
            detail="Nobody else can open this chat."
            icon="lock"
            isDisabled={!ready || busy}
            onPress={makePrivate}
            pending={revokeMutation.isPending}
            selected={ready && !shareUrl}
            title="Only you"
          />
          <View className="ml-[60px] h-px bg-border" />
          <AccessOption
            detail="Anyone with the link can read it, including later messages. They can't reply."
            icon="globe"
            isDisabled={!ready || busy}
            onPress={() => {
              if (!shareUrl && !busy) createMutation.mutate();
            }}
            pending={createMutation.isPending}
            selected={ready && Boolean(shareUrl)}
            title="Anyone with the link"
          />
        </View>
        {!online ? (
          <Text className="px-4 text-[13px] leading-[18px] text-muted-foreground">
            Connect to the internet to change sharing.
          </Text>
        ) : shareQuery.isError ? (
          <View className="flex-row items-center gap-2 px-4">
            <Text className="text-[13px] leading-[18px] text-muted-foreground">
              Sharing settings couldn't be loaded.
            </Text>
            <Pressable accessibilityRole="button" onPress={() => void shareQuery.refetch()}>
              <Text className="text-[13px] font-semibold text-link">Try again</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {shareUrl ? (
        <Pressable
          accessibilityHint="Copies the link"
          accessibilityLabel={`Read-only link, ${shareUrl}`}
          accessibilityRole="button"
          className="flex-row items-center gap-3 rounded-2xl bg-secondary px-4 py-3.5 border-continuous active:bg-muted"
          onPress={() => void copy()}
        >
          <Text
            ellipsizeMode="middle"
            numberOfLines={1}
            className="flex-1 text-[15px] leading-5 text-foreground"
          >
            {shareUrl.replace(/^https:\/\//, "")}
          </Text>
          <StyledSymbolView
            accessibilityElementsHidden
            name="doc.on.doc"
            size={16}
            tintColorClassName="accent-muted-foreground"
          />
        </Pressable>
      ) : null}

      <Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
        <HStack spacing={12}>
          <Button
            onPress={() => void copy()}
            modifiers={[buttonStyle("glassProminent"), controlSize("large"), disabled(!ready)]}
          >
            <Label
              systemImage="link"
              title="Copy link"
              modifiers={[frame({ maxWidth: Number.POSITIVE_INFINITY })]}
            />
          </Button>
          <Button
            onPress={() => void share()}
            modifiers={[buttonStyle("glass"), controlSize("large"), disabled(!ready)]}
          >
            <Label
              systemImage="square.and.arrow.up"
              title="Share"
              modifiers={[frame({ maxWidth: Number.POSITIVE_INFINITY })]}
            />
          </Button>
        </HStack>
      </Host>
    </View>
  );
}
