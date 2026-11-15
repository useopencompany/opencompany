import { useNavigation } from "expo-router";

/**
 * Closes the whole model sheet from any screen in its inner stack. The inner stack is one screen
 * of the chat stack, so going back there removes the sheet rather than popping a nested screen.
 */
export function useCloseModelSheet(): () => void {
  const navigation = useNavigation();
  return () => navigation.getParent()?.goBack();
}
