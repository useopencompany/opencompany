import { Stack } from "expo-router";
import { useState } from "react";
import { Alert, Text, View } from "react-native";

export default function SecondScreen() {
  const [isFavorite, setIsFavorite] = useState(false);

  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button icon="headlight.daytime" onPress={() => Alert.alert("Sidebar")} />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={isFavorite ? "star.fill" : "star"}
          onPress={() => setIsFavorite(!isFavorite)}
        />
        <Stack.Toolbar.Button icon="square.and.arrow.up" onPress={() => Alert.alert("Share")} />
      </Stack.Toolbar>
      <Stack.Screen options={{ headerTransparent: true }} />
      <View className="flex-1 items-center justify-center bg-background p-4">
        <Text className="text-foreground">Second Stack Screen</Text>
      </View>
    </>
  );
}
