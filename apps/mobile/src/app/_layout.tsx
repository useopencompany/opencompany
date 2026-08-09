import { KeyboardProvider } from "react-native-keyboard-controller";
import { RootNavigator } from "@/pages/root-navigator";

export default function RootLayout() {
  return (
    <KeyboardProvider>
      <RootNavigator />
    </KeyboardProvider>
  );
}
