import type { ReactElement } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

interface ValueEvent {
  value: string;
}

interface HeightEvent {
  height: number;
}

interface FocusEvent {
  focused: boolean;
}

export interface NativeChatComposerViewProps extends ViewProps {
  accentColor: string;
  accentForegroundColor: string;
  bottomInset: number;
  disabled: boolean;
  hasAttachments: boolean;
  children?: ReactElement;
  onAttachmentPress?: () => void;
  onComposerHeightChange?: (event: NativeSyntheticEvent<HeightEvent>) => void;
  onFocusChange?: (event: NativeSyntheticEvent<FocusEvent>) => void;
  onSend?: (event: NativeSyntheticEvent<ValueEvent>) => void;
}
