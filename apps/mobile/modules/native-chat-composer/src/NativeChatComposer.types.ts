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
  blurRequest: number;
  bottomInset: number;
  disabled: boolean;
  focusRequest: number;
  hasAttachments: boolean;
  isGenerating: boolean;
  isStopping: boolean;
  value: string;
  children?: ReactElement;
  onAttachmentPress?: () => void;
  onComposerHeightChange?: (event: NativeSyntheticEvent<HeightEvent>) => void;
  onChangeText?: (event: NativeSyntheticEvent<ValueEvent>) => void;
  onFocusChange?: (event: NativeSyntheticEvent<FocusEvent>) => void;
  onSend?: (event: NativeSyntheticEvent<ValueEvent>) => void;
  onStop?: () => void;
}
