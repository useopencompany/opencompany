import type { ToolSet } from "ai";

export type PersonalAgentDelivery = {
  tools: ToolSet;
  systemBlock: string;
  // Once transport has been attempted, avoid another unsolicited fallback on ambiguous failure.
  hasReply(): boolean;
  startTyping(): void;
  sendFallback(text: string): Promise<void>;
};
