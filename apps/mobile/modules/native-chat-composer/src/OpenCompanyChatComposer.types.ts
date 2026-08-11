import type { NativeSyntheticEvent, ViewProps } from "react-native";

interface ValueEvent {
  value: string;
}

interface HeightEvent {
  height: number;
}

export interface NativeChatComposerViewProps extends ViewProps {
  accentColor: string;
  accentForegroundColor: string;
  bottomInset: number;
  disabled: boolean;
  onAttachmentPress?: () => void;
  onComposerHeightChange?: (event: NativeSyntheticEvent<HeightEvent>) => void;
  onSend?: (event: NativeSyntheticEvent<ValueEvent>) => void;
}
