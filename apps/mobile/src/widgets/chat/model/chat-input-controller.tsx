import { createContext, type ReactNode, type RefObject, use, useRef, useState } from "react";
import { KeyboardController, useKeyboardHandler } from "react-native-keyboard-controller";
import { type SharedValue, useSharedValue } from "react-native-reanimated";

export type KeyboardOwner = "composer" | "sidebar" | null;

export interface ComposerInputHandle {
  blur: () => void;
  focus: () => void;
  isFocused: () => boolean;
}

interface ChatInputControllerValue {
  composerInputRef: RefObject<ComposerInputHandle | null>;
  drawerOpen: boolean;
  dismissSearchRequestId: number;
  focusRequestId: number;
  keyboardOwner: KeyboardOwner;
  keyboardHeight: SharedValue<number>;
  keyboardProgress: SharedValue<number>;
  consumeComposerFocusRequest: (requestId: number) => boolean;
  dismissComposer: () => Promise<void>;
  dismissSearch: () => Promise<void>;
  requestComposerFocus: () => void;
  setDrawerOpen: (open: boolean) => void;
  setKeyboardOwner: (owner: KeyboardOwner) => void;
}

const ChatInputControllerContext = createContext<ChatInputControllerValue | null>(null);

export function ChatInputControllerProvider({ children }: { children: ReactNode }) {
  const composerInputRef = useRef<ComposerInputHandle>(null);
  const consumedFocusRequestRef = useRef(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dismissSearchRequestId, setDismissSearchRequestId] = useState(0);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const [keyboardOwner, setKeyboardOwner] = useState<KeyboardOwner>(null);
  const keyboardHeight = useSharedValue(0);
  const keyboardProgress = useSharedValue(0);

  // iOS's provider values jump to the destination in onStart. Track the actual
  // frames instead, including interactive dismissal, without a JS render per frame.
  useKeyboardHandler({
    onMove: (event) => {
      "worklet";
      keyboardHeight.set(event.height);
      keyboardProgress.set(event.progress);
    },
    onInteractive: (event) => {
      "worklet";
      keyboardHeight.set(event.height);
      keyboardProgress.set(event.progress);
    },
    onEnd: (event) => {
      "worklet";
      keyboardHeight.set(event.height);
      keyboardProgress.set(event.progress);
    },
  });

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
        keyboardHeight,
        keyboardProgress,
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
