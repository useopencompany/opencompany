import { Stack } from "expo-router";
import { Text, View } from "react-native";

export default function TasksScreen() {
  return (
    <>
      <Stack.Screen options={{ headerTitle: "", headerTransparent: true }} />

      <View className="flex-1 items-center justify-center">
        <Text>Tasks Screen</Text>
      </View>
    </>
  );
}
