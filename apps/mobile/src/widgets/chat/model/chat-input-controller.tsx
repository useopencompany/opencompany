import {
  createContext,
  type ReactNode,
  type RefObject,
  use,
  useEffect,
  useRef,
  useState,
} from "react";
import type { TextInput } from "react-native";
import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";

export type KeyboardOwner = "composer" | "sidebar" | null;

interface ChatInputControllerValue {
  composerInputRef: RefObject<TextInput | null>;
  drawerOpen: boolean;
  dismissSearchRequestId: number;
  focusRequestId: number;
  keyboardOwner: KeyboardOwner;
  consumeComposerFocusRequest: (requestId: number) => boolean;
  dismissComposer: () => Promise<void>;
  dismissSearch: () => Promise<void>;
  requestComposerFocus: () => void;
  setDrawerOpen: (open: boolean) => void;
  setKeyboardOwner: (owner: KeyboardOwner) => void;
}

const ChatInputControllerContext = createContext<ChatInputControllerValue | null>(null);

export function ChatInputControllerProvider({ children }: { children: ReactNode }) {
  const composerInputRef = useRef<TextInput>(null);
  const consumedFocusRequestRef = useRef(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dismissSearchRequestId, setDismissSearchRequestId] = useState(0);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const [keyboardOwner, setKeyboardOwner] = useState<KeyboardOwner>(null);

  useEffect(() => {
    const subscription = KeyboardEvents.addListener("keyboardDidHide", () => {
      setKeyboardOwner(null);
    });
    return () => subscription.remove();
  }, []);

  const dismissComposer = async () => {
    composerInputRef.current?.blur();
    await KeyboardController.dismiss();
  };

  return (
    <ChatInputControllerContext
      value={{
        composerInputRef,
        drawerOpen,
        dismissSearchRequestId,
        focusRequestId,
        keyboardOwner,
        consumeComposerFocusRequest: (requestId) => {
          if (requestId <= consumedFocusRequestRef.current) return false;
          consumedFocusRequestRef.current = requestId;
          return true;
        },
        dismissComposer,
        dismissSearch: async () => {
          setDismissSearchRequestId((value) => value + 1);
          await KeyboardController.dismiss();
        },
        requestComposerFocus: () => setFocusRequestId((value) => value + 1),
        setDrawerOpen,
        setKeyboardOwner,
      }}
    >
      {children}
    </ChatInputControllerContext>
  );
}

export function useChatInputController(): ChatInputControllerValue {
  const context = use(ChatInputControllerContext);
  if (!context) {
    throw new Error("useChatInputController must be used inside ChatInputControllerProvider.");
  }
  return context;
}
