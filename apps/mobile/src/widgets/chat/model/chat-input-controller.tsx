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

  // Where the current keyboard transition starts and ends.
  const transitionFrom = useSharedValue(0);
  const transitionTo = useSharedValue(0);
  const lastInteractiveBelowRest = useSharedValue(false);

  // iOS's provider values jump to the destination in onStart. Track the actual
  // frames instead, including interactive dismissal, without a JS render per frame.
  //
  // Whenever the focused text view changes size, such as on every new line in the composer, iOS
  // shifts the keyboard view for a moment and the library reports it as a move: a 335pt keyboard
  // read as 355 to 560pt, which lifted the composer for a frame, or a line lower, which dropped
  // it. Real frames always lie between a transition's ends, and an interactive drag only lowers
  // the keyboard in a run of frames, so the handlers drop frames outside the range and lone
  // frames below the resting keyboard.
  useKeyboardHandler({
    onStart: (event) => {
      "worklet";
      transitionFrom.set(keyboardHeight.get());
      transitionTo.set(event.height);
      lastInteractiveBelowRest.set(false);
    },
    onMove: (event) => {
      "worklet";
      const low = Math.min(transitionFrom.get(), transitionTo.get());
      const high = Math.max(transitionFrom.get(), transitionTo.get());
      keyboardHeight.set(Math.min(Math.max(event.height, low), high));
      keyboardProgress.set(Math.min(Math.max(event.progress, 0), 1));
    },
    onInteractive: (event) => {
      "worklet";
      const height = Math.min(event.height, transitionTo.get());
      const belowRest = height < transitionTo.get();
      // A drag takes effect from its second frame, a delay of one frame.
      if (!belowRest || lastInteractiveBelowRest.get()) {
        keyboardHeight.set(height);
        keyboardProgress.set(Math.min(event.progress, 1));
      }
      lastInteractiveBelowRest.set(belowRest);
    },
    onEnd: (event) => {
      "worklet";
      transitionTo.set(event.height);
      lastInteractiveBelowRest.set(false);
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
