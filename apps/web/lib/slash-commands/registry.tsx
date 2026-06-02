import type { QueryClient } from "@tanstack/react-query";
import { Eraser, type LucideIcon } from "lucide-react";
import type { useRouter } from "next/navigation";
import type { useToast } from "@/components/ToastProvider";
import { createAgentSession, createAgentSessionFromPrompt } from "@/lib/agent-sessions/actions";
import { type AgentSessionPayload, seedSessionQueries } from "@/lib/agent-sessions/payload";

/**
 * Everything a slash command needs to do its job. Kept deliberately broad so new
 * commands can be added by appending to {@link SLASH_COMMANDS} without touching the
 * composer wiring.
 */
export type SlashCommandContext = {
  /** The session the command was invoked from (carries `agentId`, `agentName`, …). */
  session: AgentSessionPayload;
  workspaceId: string;
  router: ReturnType<typeof useRouter>;
  queryClient: QueryClient;
  /** Update the composer's textarea value. */
  setInput: (value: string) => void;
  showToast: ReturnType<typeof useToast>["showToast"];
  /** Text that followed the command token on the same message (the "rest"). */
  args: string;
};

export type SlashCommand = {
  /** Stable identifier, also the matchable token (e.g. "clear" → `/clear`). */
  id: string;
  /** What renders in the menu, including the leading slash. */
  trigger: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Extra terms to match against, beyond `id`/`title`. */
  keywords?: string[];
  run: (ctx: SlashCommandContext) => void | Promise<void>;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "clear",
    trigger: "/clear",
    title: "Clear conversation",
    description: "Start a fresh session with this agent",
    icon: Eraser,
    keywords: ["new", "reset", "fresh", "restart"],
    run: async ({ session, workspaceId, router, queryClient, setInput, showToast, args }) => {
      // Text after the command becomes the fresh session's first message (sent
      // immediately, like the home prompt). No text → a clean empty session.
      const prompt = args.trim();
      const result = prompt
        ? await createAgentSessionFromPrompt(session.agentId, prompt)
        : await createAgentSession(session.agentId);
      if (!result.ok) {
        if ("redirectTo" in result) {
          router.push(result.redirectTo);
          return;
        }
        showToast({
          title: "Couldn't start a new session",
          description: result.error,
          tone: "error",
        });
        return;
      }
      setInput("");
      seedSessionQueries(queryClient, workspaceId, result.detail);
      router.push(`/session/${result.session.id}`);
    },
  },
];

/**
 * Locate the active slash token at the caret. Matches a `/word` token that is at the
 * start of the input or immediately after whitespace and ends at the caret — so the
 * menu can open mid-message (e.g. "fix the bug /cl"), not just at position 0.
 */
export function getSlashContext(
  value: string,
  caret: number,
): { query: string; start: number; end: number } | null {
  const before = value.slice(0, caret);
  const match = before.match(/(?:^|\s)(\/\w*)$/);
  const token = match?.[1]; // includes the leading slash
  if (!token) return null;
  return { query: token.slice(1), start: caret - token.length, end: caret };
}

/**
 * Find a command token in a message being sent. A command counts only when it's the
 * leading token of the trimmed input and the command word is followed by a space or
 * end-of-string (so "/clearing" and "/clear-cache" are NOT commands). Everything
 * after the token is returned as `args` (the new prompt). Returns null for incidental
 * mid-sentence slash tokens.
 */
export function parseSlashCommand(input: string): { command: SlashCommand; args: string } | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/(\w+)(?=\s|$)/);
  const word = match?.[1];
  if (!word) return null;
  const command = SLASH_COMMANDS.find((c) => c.id.toLowerCase() === word.toLowerCase());
  if (!command) return null;
  return { command, args: trimmed.slice(match[0].length).trim() };
}

/**
 * Filter commands for a query (the text after the leading slash). Prefix matches on
 * the command id rank first, then any substring match on id/title/keywords.
 */
export function matchSlashCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;

  const scored = SLASH_COMMANDS.map((command) => {
    const haystack = [command.id, command.title, ...(command.keywords ?? [])]
      .join(" ")
      .toLowerCase();
    if (command.id.toLowerCase().startsWith(q)) return { command, rank: 0 };
    if (haystack.includes(q)) return { command, rank: 1 };
    return { command, rank: -1 };
  });

  return scored
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.command);
}
