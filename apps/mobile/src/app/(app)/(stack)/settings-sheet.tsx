import { Host } from "@expo/ui";
import { Button } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize } from "@expo/ui/swift-ui/modifiers";
import { router } from "expo-router";
import { Alert, ScrollView, Text, View } from "react-native";
import { useAuth } from "@/features/auth";
import { PressableScale } from "@/shared/ui/pressable-scale";
import { StyledImage } from "@/shared/ui/styled-image";

const getInitials = (firstName: string | null, lastName: string | null, email: string): string => {
  const initials = [firstName, lastName]
    .map((part) => part?.trim().at(0))
    .filter(Boolean)
    .join("")
    .toUpperCase();

  return initials || email.trim().at(0)?.toUpperCase() || "?";
};

export default function SettingsSheet() {
  const { profile, signOut } = useAuth();
  const name = [profile?.firstName, profile?.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  const displayName = name || profile?.email;
  const initials = profile ? getInitials(profile.firstName, profile.lastName, profile.email) : null;

  return (
    <ScrollView
      className="bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="grow items-center gap-10 px-6 py-8"
    >
      {profile ? (
        <View className="w-full items-center">
          <View className="items-center">
            {profile.avatarUrl ? (
              <StyledImage
                accessibilityLabel={displayName}
                className="size-14 rounded-full bg-secondary"
                contentFit="cover"
                source={profile.avatarUrl}
              />
            ) : (
              <View
                accessibilityLabel={displayName}
                className="size-14 items-center justify-center rounded-full bg-accent"
              >
                <Text className="text-[30px] font-semibold text-accent-foreground">{initials}</Text>
              </View>
            )}

            <View className="w-full items-center px-4 mt-2">
              <Text
                numberOfLines={1}
                selectable
                className="max-w-full text-center text-[20px] font-semibold text-foreground"
              >
                {displayName}
              </Text>
              <Text
                numberOfLines={1}
                selectable
                className="max-w-full text-center text-[15px] leading-6 text-muted-foreground mt-1"
              >
                {profile.email}
              </Text>
            </View>
          </View>

          <PressableScale className="border-gray-200 border rounded-full py-1.5 px-2 mt-3">
            <Text>Edit Profile</Text>
          </PressableScale>
        </View>
      ) : null}

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
