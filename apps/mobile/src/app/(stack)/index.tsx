import { Stack } from "expo-router";
import { useState } from "react";
import { Alert, Text, View } from "react-native";

export default function FirstStackScreen() {
  const [isFavorite, setIsFavorite] = useState(false);

  return (
    <>
      <Stack.Screen options={{ headerTransparent: true, headerTitle: "" }} />

      <View style={{ flex: 1 }}>
        <Text>First Stack Screen</Text>
      </View>
    </>
  );
}
