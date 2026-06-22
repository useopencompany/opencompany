import type { QueryClient } from "@tanstack/react-query";
import { Eraser, type LucideIcon, MessageSquarePlus } from "lucide-react";
import type { useRouter } from "next/navigation";
import { showOutOfCreditsToast } from "@/components/billing/out-of-credits-toast";
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
  surface: "company" | "personal";
  workspaceId: string;
  router: ReturnType<typeof useRouter>;
  sessionHref: (sessionId: string) => string;
  queryClient: QueryClient;
  /** Update the composer's textarea value. */
  setInput: (value: string) => void;
  /**
   * Insert a token (e.g. `@skill/<id> `) at the caret, replacing the active slash token, and
   * leave the caret after it so the user can keep typing. Used by skill-derived commands.
   */
  insertMention: (token: string) => void;
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
  /**
   * Run as soon as the command is chosen from the menu, instead of inserting its trigger and
   * waiting for the user to send. Built-in commands (which take args after the trigger, e.g.
   * `/clear <prompt>`) leave this off; skill commands set it so picking `/<command>` swaps in
   * the mention in a single step rather than `/<command>` → mention → send.
   */
  applyOnSelect?: boolean;
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
    run: async ({
      session,
      surface,
      workspaceId,
      router,
      sessionHref,
      queryClient,
      setInput,
      showToast,
      args,
    }) => {
      // Text after the command becomes the fresh session's first message (sent
      // immediately, like the home prompt). No text → a clean empty session.
      const prompt = args.trim();
      const result = prompt
        ? await createAgentSessionFromPrompt(session.agentId, prompt, undefined, [], { surface })
        : await createAgentSession(session.agentId, { surface });
      if (!result.ok) {
        if ("redirectTo" in result) {
          showOutOfCreditsToast({ showToast, router, redirectTo: result.redirectTo });
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
      router.push(sessionHref(result.session.id));
    },
  },
  {
    id: "btw",
    trigger: "/btw",
    title: "Start a session on the side",
    description: "Spin up a new session with this agent without leaving this one",
    icon: MessageSquarePlus,
    keywords: ["background", "side", "parallel", "by the way", "new", "spawn", "aside"],
    run: async ({
      session,
      surface,
      workspaceId,
      router,
      sessionHref,
      queryClient,
      setInput,
      showToast,
      args,
    }) => {
      // Same as /clear (fresh session with this agent), but we stay put instead of
      // navigating: the new session surfaces in the sidebar and via the toast's "Open".
      // Text after the command becomes the new session's first message; no text → a
      // clean empty session you can open later.
      const prompt = args.trim();
      const result = prompt
        ? await createAgentSessionFromPrompt(session.agentId, prompt, undefined, [], { surface })
        : await createAgentSession(session.agentId, { surface });
      if (!result.ok) {
        if ("redirectTo" in result) {
          showOutOfCreditsToast({ showToast, router, redirectTo: result.redirectTo });
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
      // Surfaces the new session in the sidebar list without navigating to it.
      seedSessionQueries(queryClient, workspaceId, result.detail);
      const sessionId = result.session.id;
      showToast({
        title: prompt ? "Working on it in a new session" : "New session started",
        action: {
          label: "Open",
          onClick: () => router.push(sessionHref(sessionId)),
        },
      });
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
export function parseSlashCommand(
  input: string,
  commands: SlashCommand[] = SLASH_COMMANDS,
): { command: SlashCommand; args: string } | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/(\w+)(?=\s|$)/);
  const word = match?.[1];
  if (!word) return null;
  const command = commands.find((c) => c.id.toLowerCase() === word.toLowerCase());
  if (!command) return null;
  return { command, args: trimmed.slice(match[0].length).trim() };
}

/**
 * Filter commands for a query (the text after the leading slash). Prefix matches on
 * the command id rank first, then any substring match on id/title/keywords.
 */
export function matchSlashCommands(
  query: string,
  commands: SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;

  const scored = commands.map((command) => {
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
