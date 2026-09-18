import { Button, Host, HStack } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize } from "@expo/ui/swift-ui/modifiers";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import { until } from "until-async";
import { useAuth } from "@/features/auth";
import { StyledSymbolView } from "@/shared/ui/styled-symbol-view";
import { useToast } from "@/shared/ui/toast";

export function WorkspaceSelectionScreen() {
  const auth = useAuth();
  const { showErrorToast } = useToast();

  const handleSelectWorkspace = async (workspaceId: string) => {
    if (auth.selectingWorkspaceId) return;
    const [error] = await until(() => auth.selectWorkspace(workspaceId));
    if (error) showErrorToast(error.message, error, "auth.workspace.select");
  };

  const handleRetry = async () => {
    const [error] = await until(auth.refreshIdentity);
    if (error) showErrorToast(error.message, error, "auth.identity.refresh");
  };

  const handleSignOut = async () => {
    const [error] = await until(auth.signOut);
    if (error) showErrorToast(error.message, error, "auth.sign-out");
  };

  return (
    <FlatList
      className="flex-1 bg-background"
      contentContainerClassName="px-5 py-6 gap-3 grow"
      contentInsetAdjustmentBehavior="automatic"
      data={auth.workspaces}
      keyExtractor={(item) => item.id}
      ListHeaderComponent={
        <View className="gap-2 pb-3">
          <Text className="text-[17px] leading-6 text-foreground">
            Select the workspace you want to use on this device.
          </Text>
          {auth.errorMessage ? (
            <Text selectable className="text-[15px] leading-5 text-red-600 dark:text-red-400">
              {auth.errorMessage}
            </Text>
          ) : null}
        </View>
      }
      ListFooterComponent={
        <View className="mt-8">
          <Host matchContents>
            <HStack>
              {auth.errorMessage && auth.workspaces.length === 0 ? (
                <Button
                  label={auth.isRefreshingIdentity ? "Loading..." : "Retry"}
                  onPress={() => void handleRetry()}
                  systemImage="arrow.clockwise"
                  modifiers={[buttonStyle("glassProminent"), controlSize("large")]}
                />
              ) : null}
              <Button
                label={auth.isSigningOut ? "Signing out..." : "Sign out"}
                onPress={() => void handleSignOut()}
                systemImage="rectangle.portrait.and.arrow.right"
                modifiers={[buttonStyle("glass"), controlSize("large")]}
              />
            </HStack>
          </Host>
        </View>
      }
      renderItem={({ item }) => {
        const isSelected = auth.selectingWorkspaceId === item.id;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: isSelected, disabled: auth.selectingWorkspaceId !== null }}
            className="min-h-14 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 active:bg-secondary disabled:opacity-60 border-continuous"
            disabled={auth.selectingWorkspaceId !== null}
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
