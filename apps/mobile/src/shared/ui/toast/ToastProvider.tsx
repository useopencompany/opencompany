import { createContext, type ReactNode, use, useRef, useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";

import { Toast } from "./Toast";

interface ToastContextValue {
  showToast: (message: string, options?: { duration?: number }) => void;
  showErrorToast: (message: string, error: unknown, context?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const safeAreaInsets = useSafeAreaInsets();
  const nextIdRef = useRef(0);
  const [queue, setQueue] = useState<Array<{ id: number; message: string; duration: number }>>([]);
  const visibleToast = queue[0];

  const showToast = (message: string, options?: { duration?: number }) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;

    setQueue((currentQueue) => [
      ...currentQueue,
      { id, message, duration: options?.duration ?? 4000 },
    ]);
  };

  const showErrorToast = (message: string, error: unknown, context?: string) => {
    console.error(context ? `[${context}] ${message}` : message, error);
    showToast(message);
  };

  const handleExitComplete = () => {
    setQueue((currentQueue) => currentQueue.slice(1));
  };

  return (
    <ToastContext.Provider value={{ showToast, showErrorToast }}>
      {children}
      {visibleToast ? (
        <FullWindowOverlay unstable_accessibilityContainerViewIsModal={false}>
          <GestureHandlerRootView className="flex-1" pointerEvents="box-none">
            <View
              className="absolute inset-x-5 min-h-14"
              pointerEvents="box-none"
              style={{ top: safeAreaInsets.top + 8 }}
            >
              <Toast
                key={visibleToast.id}
                duration={visibleToast.duration}
                message={visibleToast.message}
                onExitComplete={handleExitComplete}
              />
            </View>
          </GestureHandlerRootView>
        </FullWindowOverlay>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = use(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return { showToast: context.showToast, showErrorToast: context.showErrorToast };
}
