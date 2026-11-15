import { requireNativeView } from "expo";
import type { Ref } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import type {
  ComposerSegment,
  ComposerTokenSegment,
} from "../model/quick-actions/composer-segments";

export type QuickActionTriggerCharacter = "@" | "/" | "#";

export interface QuickActionTrigger {
  trigger: QuickActionTriggerCharacter;
  query: string;
}

/** The commands the native view runs on the main thread. */
export interface NativeComposerInputRef {
  focus: () => Promise<void>;
  blur: () => Promise<void>;
  clear: () => Promise<void>;
  /** Replaces all content without a change event. Only call while the input is blurred. */
  setContent: (segments: ComposerSegment[]) => Promise<void>;
  /** Replaces the active trigger and its query with the tag, followed by a space. */
  insertToken: (token: ComposerTokenSegment) => Promise<void>;
}

type TriggerEvent =
  | { active: false }
  | { active: true; trigger: QuickActionTriggerCharacter; query: string };

interface NativeComposerInputProps extends ViewProps {
  editable: boolean;
  inputAccessibilityLabel: string;
  maxHeight: number;
  placeholder: string;
  placeholderColor: string;
  selectionColor: string;
  submitsHighlighted: boolean;
  textColor: string;
  tokenColor: string;
  triggers: QuickActionTriggerCharacter[];
  onChangeContent: (event: NativeSyntheticEvent<{ segments: ComposerSegment[] }>) => void;
  onInputBlur: () => void;
  onInputFocus: () => void;
  onSubmitHighlighted: () => void;
  onTriggerChange: (event: NativeSyntheticEvent<TriggerEvent>) => void;
  ref?: Ref<NativeComposerInputRef>;
}

const NativeView = requireNativeView<NativeComposerInputProps>("NativeComposerInput");

/**
 * A UITextView that holds tags: atomic SF Symbol and label runs inserted from the quick action
 * menu. It sizes itself up to `maxHeight` and then scrolls, and reports `@`, `/`, or `#` triggers
 * typed at the start of a word.
 */
export function NativeComposerInput({
  onBlur,
  onChangeContent,
  onFocus,
  onTriggerChange,
  ...props
}: Omit<
  NativeComposerInputProps,
  "onChangeContent" | "onInputBlur" | "onInputFocus" | "onTriggerChange"
> & {
  onBlur: () => void;
  onChangeContent: (segments: ComposerSegment[]) => void;
  onFocus: () => void;
  onTriggerChange: (trigger: QuickActionTrigger | null) => void;
}) {
  return (
    <NativeView
      {...props}
      collapsable={false}
      onChangeContent={({ nativeEvent }) => onChangeContent(nativeEvent.segments)}
      onInputBlur={onBlur}
      onInputFocus={onFocus}
      onTriggerChange={({ nativeEvent }) =>
        onTriggerChange(
          nativeEvent.active ? { trigger: nativeEvent.trigger, query: nativeEvent.query } : null,
        )
      }
    />
  );
}
