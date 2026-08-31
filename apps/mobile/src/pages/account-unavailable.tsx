import { Button, Host } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize } from "@expo/ui/swift-ui/modifiers";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useAuth } from "@/features/auth";
import { useToast } from "@/shared/ui/toast";

export function AccountUnavailableScreen() {
  const { accountUnavailableReason, initializationError, refreshIdentity, signOut } = useAuth();
  const { showToast } = useToast();
  const [activeAction, setActiveAction] = useState<"refresh" | "sign-out" | null>(null);
  const isIncomplete = accountUnavailableReason === "incomplete-onboarding";

  const handleRefresh = async () => {
    if (activeAction) return;
    setActiveAction("refresh");
    const result = await refreshIdentity();
    if (!result.success && result.error) showToast(result.error);
    setActiveAction(null);
  };

  const handleSignOut = async () => {
    if (activeAction) return;
    setActiveAction("sign-out");
    const result = await signOut();
    if (!result.success && result.error) showToast(result.error);
    setActiveAction(null);
  };

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="grow justify-center gap-8 px-6 py-10"
      contentInsetAdjustmentBehavior="automatic"
    >
      <View className="gap-3">
        <Text className="text-[28px] font-bold tracking-tight text-foreground">
          {isIncomplete ? "Finish setting up your account" : "No workspaces available"}
        </Text>
        <Text className="text-[17px] leading-6 text-muted-foreground">
          {isIncomplete
            ? "Complete onboarding in the opencompany web app, then refresh here."
            : "Your account does not have access to a workspace. Ask a workspace admin for access, then refresh here."}
        </Text>
        {initializationError ? (
          <Text selectable className="text-[15px] leading-5 text-red-600 dark:text-red-400">
            {initializationError}
          </Text>
        ) : null}
      </View>

      <View className="gap-3">
        <Host matchContents={{ horizontal: true, vertical: false }} style={{ height: 44 }}>
          <Button
            label={activeAction === "refresh" ? "Refreshing..." : "Refresh"}
            onPress={() => void handleRefresh()}
            modifiers={[buttonStyle("glassProminent"), controlSize("large")]}
          />
        </Host>
        <Host matchContents={{ horizontal: true, vertical: false }} style={{ height: 44 }}>
          <Button
            label={activeAction === "sign-out" ? "Signing out..." : "Sign out"}
            onPress={() => void handleSignOut()}
            modifiers={[buttonStyle("glass"), controlSize("large")]}
          />
        </Host>
      </View>
    </ScrollView>
  );
}
