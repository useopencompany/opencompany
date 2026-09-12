import type { ReactElement } from "react";
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
  autoFocus: boolean;
  bottomInset: number;
  disabled: boolean;
  hasAttachments: boolean;
  isGenerating: boolean;
  isStopping: boolean;
  value: string;
  children?: ReactElement;
  onAttachmentPress?: () => void;
  onComposerHeightChange?: (event: NativeSyntheticEvent<HeightEvent>) => void;
  onChangeText?: (event: NativeSyntheticEvent<ValueEvent>) => void;
  onSend?: (event: NativeSyntheticEvent<ValueEvent>) => void;
  onStop?: () => void;
}
