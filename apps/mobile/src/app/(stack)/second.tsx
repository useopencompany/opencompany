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
      <View style={{ flex: 1, padding: 16, alignItems: "center", justifyContent: "center" }}>
        <Text>Second Stack Screen</Text>
      </View>
    </>
  );
}
