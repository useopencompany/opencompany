import type { MessagingProviderInfo } from "./types";

// Secret-free catalog of channels the product knows about. The Channels tab renders from this so a
// provider card exists before the platform is configured. Adding Telegram later = one entry here +
// a new provider factory; nothing else in this list-driven UI changes.
export const MESSAGING_PROVIDERS: readonly MessagingProviderInfo[] = [
  {
    id: "whatsapp",
    label: "WhatsApp",
    description: "Chat with your personal agent over WhatsApp.",
  },
] as const;

export function getMessagingProviderInfo(id: string): MessagingProviderInfo | null {
  return MESSAGING_PROVIDERS.find((provider) => provider.id === id) ?? null;
}
