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
  /**
   * A keyboard the composer did not raise (sidebar search) is up or still dismissing. The chat
   * list freezes its keyboard-driven insets and the composer stays put until it is fully gone.
   */
  foreignKeyboard: SharedValue<boolean>;
  consumeComposerFocusRequest: (requestId: number) => boolean;
  /**
   * Before a sheet or picker takes over, remembers whether the composer had focus. The composer
   * takes it back once the sheet closes or the picker finishes.
   */
  holdComposerFocus: () => void;
  takeHeldComposerFocus: () => boolean;
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
  const heldComposerFocusRef = useRef(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dismissSearchRequestId, setDismissSearchRequestId] = useState(0);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const [keyboardOwner, setKeyboardOwner] = useState<KeyboardOwner>(null);
  const keyboardHeight = useSharedValue(0);
  const keyboardProgress = useSharedValue(0);
  const foreignKeyboard = useSharedValue(false);
  const foreignOwnerActive = useSharedValue(false);

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
      if (event.height === 0 && !foreignOwnerActive.get()) foreignKeyboard.set(false);
    },
  });

  const updateKeyboardOwner = (owner: KeyboardOwner) => {
    const foreign = owner !== null && owner !== "composer";
    foreignOwnerActive.set(foreign);
    // Released by the keyboard's own dismissal (onEnd at height 0), never by the owner change,
    // so nothing reacts to the tail of a keyboard it did not ask for.
    if (foreign) foreignKeyboard.set(true);
    else if (keyboardHeight.get() === 0) foreignKeyboard.set(false);
    setKeyboardOwner(owner);
  };

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
        foreignKeyboard,
        consumeComposerFocusRequest: (requestId) => {
          if (requestId <= consumedFocusRequestRef.current) return false;
          consumedFocusRequestRef.current = requestId;
          return true;
        },
        holdComposerFocus: () => {
          heldComposerFocusRef.current = composerInputRef.current?.isFocused() ?? false;
        },
        takeHeldComposerFocus: () => {
          const held = heldComposerFocusRef.current;
          heldComposerFocusRef.current = false;
          return held;
        },
        dismissComposer,
        dismissSearch: async () => {
          setDismissSearchRequestId((value) => value + 1);
          await KeyboardController.dismiss();
        },
        requestComposerFocus: () => setFocusRequestId((value) => value + 1),
        setDrawerOpen,
        setKeyboardOwner: updateKeyboardOwner,
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
