import { requireNativeView } from "expo";

import type { NativeChatComposerViewProps } from "./OpenCompanyChatComposer.types";

export const NativeChatComposerView = requireNativeView<NativeChatComposerViewProps>(
  "OpenCompanyChatComposer",
  "OpenCompanyChatComposerView",
);
