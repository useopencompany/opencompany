import { Button, Host } from "@expo/ui/swift-ui";
import { buttonStyle } from "@expo/ui/swift-ui/modifiers";
import { router } from "expo-router";
import { Alert, ScrollView } from "react-native";
import { useAuth } from "@/features/auth";

export default function SettingsSheet() {
  const { signOut } = useAuth();

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-4">
      <Host matchContents>
        <Button
          label="Sign Out"
          onPress={() => {
            Alert.alert("Sign Out", "Are you sure you want to sign out?", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Sign Out",
                style: "destructive",
                onPress: () => {
                  router.dismiss();
                  void signOut();
                },
              },
            ]);
          }}
          role="destructive"
          modifiers={[buttonStyle("bordered")]}
        />
      </Host>
    </ScrollView>
  );
}
