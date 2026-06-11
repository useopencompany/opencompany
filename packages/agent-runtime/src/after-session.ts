import type { AgentAfterSessionConfig } from "./types";

export const AFTER_SESSION_TAG = "#after-session";
export const DEFAULT_AFTER_SESSION_IDLE_DELAY_SECONDS = 180;

// How long a session must stay idle before the platform fires the after-session check (which runs
// the legacy `#after-session` hook or, for the personal agent, spawns the memory-keeper pass). This
// is the real timing — the Inngest sleep — and is intentionally longer than a single turn so it
// fires once after the conversation truly winds down. Overridable per dispatch via the event.
export const AFTER_SESSION_IDLE_TRIGGER_SECONDS = 300;

export function extractAfterSessionConfig(body: string): AgentAfterSessionConfig | undefined {
  const prompt = extractAfterSessionPrompt(body);
  if (!prompt) return undefined;

  return {
    enabled: true,
    prompt,
    idleDelaySeconds: DEFAULT_AFTER_SESSION_IDLE_DELAY_SECONDS,
  };
}

export function extractAfterSessionPrompt(body: string) {
  const normalized = body.replace(/\r\n/g, "\n");
  const match = /(^|[^\w])#after-session(?=$|[^\w])/.exec(normalized);
  if (!match) return "";

  const tagPrefix = match[1] ?? "";
  const index = match.index + tagPrefix.length;
  const paragraphEnd = normalized.indexOf("\n\n", index);
  const rawPrompt = normalized.slice(
    index + AFTER_SESSION_TAG.length,
    paragraphEnd === -1 ? normalized.length : paragraphEnd,
  );

  return rawPrompt.replace(/^[\s:,-]+/, "").trim();
}
