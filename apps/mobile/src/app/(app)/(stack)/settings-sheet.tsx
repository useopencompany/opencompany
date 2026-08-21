import { Button, Host } from "@expo/ui/swift-ui";
import { ScrollView, Text } from "react-native";
import { useAuth } from "@/features/auth-provider";

export default function SettingsSheet() {
  const { signOut } = useAuth();

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic">
      <Text>Settings Sheet</Text>
      <Host matchContents>
        <Button label="Sign Out" onPress={signOut} />
      </Host>
    </ScrollView>
  );
}
