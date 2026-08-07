import { createLinqImessageProvider } from "./linq";

export type ImessageSendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; error: string };

export type ImessageProvider = {
  name: "linq" | "log";
  send(input: { to: string; text: string; signal?: AbortSignal }): Promise<ImessageSendResult>;
};

export function isImessageKilled(): boolean {
  return process.env.IMESSAGE_KILL_SWITCH === "true";
}

// Dev/test transport: logs instead of sending (pairing codes included), so the
// whole flow is exercisable without provider credentials.
const logProvider: ImessageProvider = {
  name: "log",
  send: async ({ to, text }) => {
    console.log(`[goat-imessage] log provider: would send to ${to}: ${text}`);
    return { ok: true, providerMessageId: null };
  },
};

// Resolves the platform-level send transport, or null when the feature is
// killed or unconfigured. A null here must unbind the tool everywhere.
export function resolveImessageProvider(): ImessageProvider | null {
  if (isImessageKilled()) return null;
  if (process.env.IMESSAGE_PROVIDER === "log") return logProvider;
  const token = process.env.LINQ_API_TOKEN;
  const fromNumber = process.env.LINQ_FROM_NUMBER;
  if (token && fromNumber) {
    return createLinqImessageProvider({
      token,
      fromNumber,
      baseUrl: process.env.LINQ_API_BASE_URL ?? null,
    });
  }
  return null;
}
