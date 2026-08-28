import { requireNativeView } from "expo";

import type { NativeChatComposerViewProps } from "./NativeChatComposer.types";

export const NativeChatComposerView = requireNativeView<NativeChatComposerViewProps>(
  "NativeChatComposer",
  "NativeChatComposerView",
);
