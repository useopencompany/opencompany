import { Button, Host } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize } from "@expo/ui/swift-ui/modifiers";
import { ScrollView, Text, View } from "react-native";
import { until } from "until-async";
import { useAuth } from "@/features/auth";
import { useToast } from "@/shared/ui/toast";

export function AccountUnavailableScreen() {
  const auth = useAuth();
  const { showErrorToast } = useToast();
  const isIncomplete = auth.accountUnavailableReason === "incomplete-onboarding";

  const handleRefresh = async () => {
    if (auth.isRefreshingIdentity || auth.isSigningOut) return;
    const [error] = await until(auth.refreshIdentity);
    if (error) showErrorToast(error.message, error, "auth.identity.refresh");
  };

  const handleSignOut = async () => {
    if (auth.isRefreshingIdentity || auth.isSigningOut) return;
    const [error] = await until(auth.signOut);
    if (error) showErrorToast(error.message, error, "auth.sign-out");
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
        {auth.errorMessage ? (
          <Text selectable className="text-[15px] leading-5 text-red-600 dark:text-red-400">
            {auth.errorMessage}
          </Text>
        ) : null}
      </View>

      <View className="gap-3">
        <Host matchContents={{ horizontal: true, vertical: false }} style={{ height: 44 }}>
          <Button
            label={auth.isRefreshingIdentity ? "Refreshing..." : "Refresh"}
            onPress={() => void handleRefresh()}
            modifiers={[buttonStyle("glassProminent"), controlSize("large")]}
          />
        </Host>
        <Host matchContents={{ horizontal: true, vertical: false }} style={{ height: 44 }}>
          <Button
            label={auth.isSigningOut ? "Signing out..." : "Sign out"}
            onPress={() => void handleSignOut()}
            modifiers={[buttonStyle("glass"), controlSize("large")]}
          />
        </Host>
      </View>
    </ScrollView>
  );
}
