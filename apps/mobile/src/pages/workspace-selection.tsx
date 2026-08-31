import { Button, Host } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize } from "@expo/ui/swift-ui/modifiers";
import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import { useAuth } from "@/features/auth";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { useToast } from "@/shared/ui/toast";

export function WorkspaceSelectionScreen() {
  const { initializationError, refreshIdentity, selectWorkspace, signOut, workspaces } = useAuth();
  const { showToast } = useToast();
  const [selectingWorkspaceId, setSelectingWorkspaceId] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const handleSelectWorkspace = async (workspaceId: string) => {
    if (selectingWorkspaceId) return;
    setSelectingWorkspaceId(workspaceId);
    const result = await selectWorkspace(workspaceId);
    if (!result.success && result.error) showToast(result.error);
    setSelectingWorkspaceId(null);
  };

  const handleRetry = async () => {
    setIsRetrying(true);
    const result = await refreshIdentity();
    if (!result.success && result.error) showToast(result.error);
    setIsRetrying(false);
  };

  const handleSignOut = async () => {
    setIsSigningOut(true);
    const result = await signOut();
    if (!result.success && result.error) showToast(result.error);
    setIsSigningOut(false);
  };

  return (
    <FlatList
      className="flex-1 bg-background"
      contentContainerClassName="px-5 py-6 gap-3 grow"
      contentInsetAdjustmentBehavior="automatic"
      data={workspaces}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={
        <View className="gap-2 pb-3">
          <Text className="text-[17px] leading-6 text-foreground">
            Select the workspace you want to use on this device.
          </Text>
          {initializationError ? (
            <Text selectable className="text-[15px] leading-5 text-red-600 dark:text-red-400">
              {initializationError}
            </Text>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        initializationError ? (
          <Text className="py-8 text-center text-[15px] text-muted-foreground">
            Your workspaces could not be loaded.
          </Text>
        ) : null
      }
      ListFooterComponent={
        <View className="mt-auto gap-3 pt-8">
          {initializationError && workspaces.length === 0 ? (
            <Host matchContents={{ horizontal: true, vertical: false }} style={{ height: 44 }}>
              <Button
                label={isRetrying ? "Refreshing..." : "Retry"}
                onPress={() => void handleRetry()}
                modifiers={[buttonStyle("glassProminent"), controlSize("large")]}
              />
            </Host>
          ) : null}
          <Host matchContents={{ horizontal: true, vertical: false }} style={{ height: 44 }}>
            <Button
              label={isSigningOut ? "Signing out..." : "Sign out"}
              onPress={() => void handleSignOut()}
              modifiers={[buttonStyle("glass"), controlSize("large")]}
            />
          </Host>
        </View>
      }
      renderItem={({ item }) => {
        const isSelected = selectingWorkspaceId === item.id;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: isSelected, disabled: selectingWorkspaceId !== null }}
            className="min-h-14 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 active:bg-secondary disabled:opacity-60 border-continuous"
            disabled={selectingWorkspaceId !== null}
            onPress={() => void handleSelectWorkspace(item.id)}
          >
            <View className="flex-1 gap-0.5">
              <Text numberOfLines={1} className="text-[17px] font-semibold text-card-foreground">
                {item.name}
              </Text>
              <Text className="text-[13px] capitalize text-muted-foreground">{item.role}</Text>
            </View>
            {isSelected ? (
              <ActivityIndicator colorClassName="accent-accent" />
            ) : (
              <StyledSymbolView
                name="chevron.right"
                size={14}
                tintColorClassName="accent-muted-foreground"
              />
            )}
          </Pressable>
        );
      }}
    />
  );
}
