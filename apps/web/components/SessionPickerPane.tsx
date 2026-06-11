"use client";

import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUp, LoaderCircle, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition } from "react";
import { useCollections } from "@/components/CollectionsProvider";
import { SessionStatusDot } from "@/components/SessionStatusDot";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import { createAgentSessionFromPrompt } from "@/lib/agent-sessions/actions";
import { seedSessionQueries } from "@/lib/agent-sessions/payload";
import {
  agentRowToListItem,
  deriveSidebarSessions,
  sortAgentsByUpdatedDesc,
} from "@/lib/collections/selectors";

type SessionPickerPaneProps = {
  // Called with the chosen session id — either an existing session picked from the
  // list or a freshly created one from the compose step.
  onPick: (sessionId: string) => void;
  onCancel: () => void;
  // Sessions already open in panes; filtered out of the list so the picker only
  // offers sessions that would actually add something.
  excludeSessionIds: string[];
};

type ComposeAgent = { id: string; name: string };

// Pane shown while the user chooses which session to open in a new split: a cmdk
// list of recent sessions plus a "new session per agent" path that expands into a
// minimal compose step. Mounts only after a client-side click (never SSR'd), so
// useLiveQuery is safe here without a hydration gate.
export default function SessionPickerPane({
  onPick,
  onCancel,
  excludeSessionIds,
}: SessionPickerPaneProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { workspaceId } = useWorkspaceContext();
  const headingId = useId();
  // Non-null while the compose step is showing; reset to null returns to the list.
  const [composeAgent, setComposeAgent] = useState<ComposeAgent | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);
  // The create-session transition lives here (not in ComposeStep) so every escape
  // hatch out of the pane — header X, Escape, and Back — can lock while a creation
  // is in flight; cancelling mid-flight would still resolve onPick later and pop a
  // pane in after the user "cancelled".
  const [isPending, startTransition] = useTransition();

  const handleComposeSubmit = (content: string) => {
    const agent = composeAgent;
    if (!agent || !content || isPending) return;
    setComposeError(null);
    startTransition(async () => {
      const result = await createAgentSessionFromPrompt(agent.id, content);
      if (!result.ok) {
        // Mirrors MainPanel's Prompt: the insufficient-credits error carries a
        // billing redirect that outranks staying in the split.
        if ("redirectTo" in result) {
          router.push(result.redirectTo);
          return;
        }
        setComposeError(result.error);
        return;
      }
      // Seed the detail cache so the new pane paints instantly instead of refetching
      // what the action just returned (same as the home-page prompt flow).
      seedSessionQueries(queryClient, workspaceId, result.detail);
      onPick(result.session.id);
    });
  };

  return (
    <section
      aria-labelledby={headingId}
      className="flex h-full flex-col bg-surface/45"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        // Locked while a session creation is in flight, same as the X/Back buttons:
        // cancelling now would still resolve onPick later and pop a pane in.
        if (isPending) return;
        // In the compose step Escape backs out one level (to the list) instead of
        // discarding the whole picker; a second Escape then cancels.
        if (composeAgent) {
          setComposeAgent(null);
          setComposeError(null);
          return;
        }
        onCancel();
      }}
    >
      <header className="flex items-center justify-between gap-2 py-2 pr-4 pl-6">
        <h2 id={headingId} className="truncate text-[12.5px] font-medium text-ink-muted">
          Open in split
        </h2>
        <button
          type="button"
          aria-label="Cancel"
          disabled={isPending}
          onClick={onCancel}
          className="shrink-0 rounded-md p-1.5 text-ink/55 transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <X size={15} strokeWidth={1.75} />
        </button>
      </header>
      {composeAgent ? (
        <ComposeStep
          agent={composeAgent}
          error={composeError}
          isPending={isPending}
          onBack={() => {
            setComposeAgent(null);
            setComposeError(null);
          }}
          onSubmit={handleComposeSubmit}
        />
      ) : (
        <PickerList
          excludeSessionIds={excludeSessionIds}
          onPick={onPick}
          onComposeAgent={setComposeAgent}
        />
      )}
    </section>
  );
}

function PickerList({
  excludeSessionIds,
  onPick,
  onComposeAgent,
}: {
  excludeSessionIds: string[];
  onPick: (sessionId: string) => void;
  onComposeAgent: (agent: ComposeAgent) => void;
}) {
  const { agentSessions, sessionStars, agents } = useCollections();
  const { data: sessionRows } = useLiveQuery((q) => q.from({ session: agentSessions }));
  const { data: starRows } = useLiveQuery((q) => q.from({ star: sessionStars }));
  const { data: agentRows } = useLiveQuery((q) => q.from({ agent: agents }));
  // Filtering is ours (`shouldFilter={false}` below, the SlashCommandMenu pattern):
  // cmdk's default filter fuzzy-matches the query against `value + keywords`, and our
  // values are uuids — hex-dense strings where a query like "ada" or "dec" would
  // surface unrelated sessions. Plain case-insensitive substring match over the
  // visible text instead.
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();

  // SidebarSessionPayload carries no agent info, so join the raw rows back to the
  // agents collection for the per-row agent label (also a search target).
  const agentNameBySessionId = useMemo(() => {
    const nameByAgentId = new Map((agentRows ?? []).map((agent) => [agent.id, agent.name]));
    return new Map(
      (sessionRows ?? []).map((row) => [row.id, nameByAgentId.get(row.agent_id) ?? ""]),
    );
  }, [sessionRows, agentRows]);

  // Same source as the sidebar's history list, minus the sessions already open in
  // panes — picking one of those would be a no-op.
  const sessions = useMemo(() => {
    const excluded = new Set(excludeSessionIds);
    return deriveSidebarSessions(sessionRows ?? [], starRows ?? []).filter(
      (session) =>
        !excluded.has(session.id) &&
        (normalizedQuery.length === 0 ||
          session.title.toLowerCase().includes(normalizedQuery) ||
          (agentNameBySessionId.get(session.id) ?? "").toLowerCase().includes(normalizedQuery)),
    );
  }, [sessionRows, starRows, excludeSessionIds, normalizedQuery, agentNameBySessionId]);

  const agentList = useMemo(
    () =>
      sortAgentsByUpdatedDesc((agentRows ?? []).map(agentRowToListItem)).filter(
        (agent) =>
          normalizedQuery.length === 0 || agent.name.toLowerCase().includes(normalizedQuery),
      ),
    [agentRows, normalizedQuery],
  );

  return (
    <Command shouldFilter={false} className="min-h-0 flex-1 bg-transparent">
      <CommandInput
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder="Search sessions or agents…"
      />
      <CommandList className="max-h-none flex-1 px-2 py-1">
        <CommandEmpty>No matches.</CommandEmpty>
        {sessions.length > 0 ? (
          <CommandGroup heading="Recent sessions">
            {sessions.map((session) => {
              const agentName = agentNameBySessionId.get(session.id) || null;
              return (
                <CommandItem
                  key={session.id}
                  // With shouldFilter={false} the value is only cmdk's selection
                  // identity (never matched against), so the uuid is exactly right.
                  value={session.id}
                  onSelect={() => onPick(session.id)}
                >
                  <SessionStatusDot status={session.status} pulse />
                  <span className="min-w-0 flex-1 truncate tracking-[-0.005em]">
                    {session.title}
                  </span>
                  {agentName ? (
                    <span className="ml-auto max-w-[120px] shrink-0 truncate text-[11.5px] text-ink-subtle">
                      {agentName}
                    </span>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
        {agentList.length > 0 ? (
          <CommandGroup heading="New session">
            {agentList.map((agent) => (
              <CommandItem
                key={agent.id}
                value={`new-${agent.id}`}
                onSelect={() => onComposeAgent({ id: agent.id, name: agent.name })}
              >
                <Plus size={14} strokeWidth={1.9} className="shrink-0 text-ink-subtle" />
                <span className="min-w-0 flex-1 truncate tracking-[-0.005em]">{agent.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </Command>
  );
}

// Minimal "first message to a new session" form: no model picker, no attachments —
// the session starts on the agent's default model and the full composer takes over
// once the pane swaps to the real SessionView. Presentational: the submit/pending/
// error state lives in the parent so the pane-level escape hatches respect it.
function ComposeStep({
  agent,
  error,
  isPending,
  onBack,
  onSubmit,
}: {
  agent: ComposeAgent;
  error: string | null;
  isPending: boolean;
  onBack: () => void;
  onSubmit: (content: string) => void;
}) {
  const [input, setInput] = useState("");
  const canSubmit = Boolean(input.trim()) && !isPending;

  const submit = () => {
    const content = input.trim();
    if (!content || isPending) return;
    onSubmit(content);
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          aria-label="Back to session list"
          disabled={isPending}
          onClick={onBack}
          className="shrink-0 rounded-md p-1 text-ink/55 transition-colors hover:bg-surface-hover hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowLeft size={14} strokeWidth={1.9} />
        </button>
        <span className="truncate text-[13px] font-medium text-ink">{agent.name}</span>
        <span className="shrink-0 text-[12px] text-ink-subtle">· new session</span>
      </div>
      {error ? <p className="text-[12px] text-danger">{error}</p> : null}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-2 shadow-[0_1px_2px_rgba(0,0,0,0.04)] focus-within:border-border-strong">
        <textarea
          // Focused on mount so the user can type the first message right away.
          autoFocus
          aria-label="First message"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter inserts a newline (the composer convention
            // everywhere else in the app); Cmd/Ctrl+Enter also sends.
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            if (event.shiftKey) return;
            event.preventDefault();
            submit();
          }}
          rows={3}
          placeholder="Ask this agent to do something"
          className="w-full resize-none bg-transparent px-1 pt-1 text-[14px] leading-6 tracking-[-0.005em] text-ink placeholder:text-ink-subtle outline-none"
        />
        <div className="flex items-center justify-end">
          <button
            type="submit"
            disabled={!canSubmit}
            aria-label={isPending ? "Starting session…" : "Start session"}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isPending ? (
              <LoaderCircle size={13} strokeWidth={2} className="animate-spin" />
            ) : (
              <ArrowUp size={13} strokeWidth={2} />
            )}
          </button>
        </div>
      </div>
    </form>
  );
}
