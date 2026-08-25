"use client";

import type { GitHubActivityEventType } from "@opencompany/brain";
import type { WikiSourceDto } from "@opencompany/protocol";
import { toast } from "@opencompany/ui/components/sonner";
import { Search } from "lucide-react";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  type GitHubRepositoryListResult,
  type LinearTeamListResult,
  listGitHubRepositoriesAction,
  listLinearTeamsAction,
} from "@/lib/brain-source-actions";
import { upsertWikiSource } from "@/lib/wiki-source-api";

type WikiScopePickerProps = {
  integrationId: string;
  source: WikiSourceDto | null;
  canConfigure: boolean;
  onSaved: (source: WikiSourceDto) => void;
};

const GITHUB_EVENT_OPTIONS: { id: GitHubActivityEventType; label: string }[] = [
  { id: "pull_request_opened", label: "Pull request opened" },
  { id: "pull_request_merged", label: "Pull request merged" },
  { id: "pull_request_commented", label: "Pull request comment" },
  { id: "issue_opened", label: "Issue created" },
  { id: "issue_commented", label: "Issue comment" },
];

export function WikiGitHubRepoPicker({
  integrationId,
  source,
  canConfigure,
  onSaved,
}: WikiScopePickerProps) {
  const saved = useMemo(() => githubReposFromConfig(source?.config), [source]);
  const savedEvents = useMemo(() => githubEventsFromConfig(source?.config), [source]);
  const [expanded, setExpanded] = useState(false);
  const [repos, setRepos] = useState<GitHubRepositoryListResult | null>(null);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Map<string, string>>(
    () => new Map(saved.map((repo) => [repo.id, repo.fullName])),
  );
  const [events, setEvents] = useState<Set<GitHubActivityEventType>>(() => new Set(savedEvents));
  const [dirty, setDirty] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!expanded || repos) return;
    let active = true;
    void listGitHubRepositoriesAction(integrationId).then(
      (result) => {
        if (active) setRepos(result);
      },
      (error: unknown) => {
        if (active)
          setRepos({ ok: false, error: errorMessage(error, "Repositories could not load.") });
      },
    );
    return () => {
      active = false;
    };
  }, [expanded, integrationId, repos]);

  const selectedCount = selection.size;
  const eventSummary =
    events.size === 0
      ? "no events"
      : GITHUB_EVENT_OPTIONS.filter((option) => events.has(option.id))
          .map((option) => option.label.toLowerCase())
          .join(", ");
  const summary =
    selectedCount === 0
      ? "No repositories selected yet — nothing is ingested until you choose some."
      : `${selectedCount} repositor${selectedCount === 1 ? "y" : "ies"} selected · ${eventSummary}.`;

  if (!expanded) {
    return (
      <CollapsedScopePicker
        summary={summary}
        action="Configure"
        canConfigure={canConfigure}
        onExpand={() => setExpanded(true)}
      />
    );
  }

  const query = search.trim().toLowerCase();
  const repoOptions = (repos?.ok ? repos.repos : []).filter(
    (repo) => !query || repo.fullName.toLowerCase().includes(query),
  );

  const save = () => {
    startTransition(async () => {
      try {
        const updated = await upsertWikiSource({
          integrationId,
          provider: "github",
          enabled: source?.enabled ?? true,
          config: {
            repos: [...selection].map(([id, fullName]) => ({ id, fullName })),
            events: [...events],
          },
        });
        setDirty(false);
        onSaved(updated);
        toast.success("GitHub source updated.");
      } catch (error) {
        toast.error(errorMessage(error, "GitHub source could not be updated."));
      }
    });
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border/70 pt-2">
      <ScopeSearch
        value={search}
        placeholder="Search repositories"
        onChange={setSearch}
        onCollapse={() => setExpanded(false)}
      />
      {repos === null ? (
        <div className="px-1 py-1.5 text-[12px] text-ink-subtle">Loading repositories…</div>
      ) : !repos.ok ? (
        <div className="px-1 py-1.5 text-[12px] text-warning">{repos.error}</div>
      ) : (
        <div className="flex max-h-[220px] flex-col gap-px overflow-y-auto rounded-md border border-border/70 p-1">
          {repoOptions.length === 0 ? (
            <div className="px-2 py-1.5 text-[12px] text-ink-subtle">No repositories found.</div>
          ) : (
            repoOptions.map((repo) => (
              <label
                key={repo.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
              >
                <input
                  type="checkbox"
                  checked={selection.has(repo.id)}
                  onChange={() => {
                    setDirty(true);
                    setSelection((current) => toggleMapValue(current, repo.id, repo.fullName));
                  }}
                  className="accent-ink"
                />
                <span className="min-w-0 flex-1 truncate">{repo.fullName}</span>
                {repo.private ? (
                  <span className="shrink-0 text-[11px] text-ink-subtle">private</span>
                ) : null}
              </label>
            ))
          )}
        </div>
      )}
      <div className="flex flex-col gap-1 rounded-md border border-border/70 p-2">
        <p className="text-[12px] font-medium text-ink">Events to ingest</p>
        {GITHUB_EVENT_OPTIONS.map((option) => (
          <label
            key={option.id}
            className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
          >
            <input
              type="checkbox"
              checked={events.has(option.id)}
              onChange={() => {
                setDirty(true);
                setEvents((current) => toggleSetValue(current, option.id));
              }}
              className="accent-ink"
            />
            <span>{option.label}</span>
          </label>
        ))}
        {events.size === 0 ? (
          <p className="text-[11.5px] leading-4 text-ink-subtle">
            No events selected — nothing is ingested from the chosen repositories.
          </p>
        ) : null}
      </div>
      <ScopeSaveButton dirty={dirty} pending={isPending} label="Save GitHub source" onSave={save} />
    </div>
  );
}

type LinearEventSelection =
  | "issue_created"
  | "issue_updated"
  | "issue_status_changed"
  | "issue_removed"
  | "comment_created"
  | "comment_updated";

const LINEAR_EVENT_OPTIONS: Array<{ id: LinearEventSelection; label: string }> = [
  { id: "issue_created", label: "Issue created" },
  { id: "issue_status_changed", label: "Status changed" },
  { id: "issue_updated", label: "Issue updated" },
  { id: "issue_removed", label: "Issue removed" },
  { id: "comment_created", label: "Comment added" },
  { id: "comment_updated", label: "Comment updated" },
];

export function WikiLinearTeamPicker({
  integrationId,
  source,
  canConfigure,
  onSaved,
}: WikiScopePickerProps) {
  const saved = useMemo(() => linearTeamsFromConfig(source?.config), [source]);
  const savedEvents = useMemo(() => linearEventsFromConfig(source?.config), [source]);
  const [expanded, setExpanded] = useState(false);
  const [teams, setTeams] = useState<LinearTeamListResult | null>(null);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Map<string, { name: string; key?: string }>>(
    () =>
      new Map(
        saved.map((team) => [team.id, { name: team.name, ...(team.key ? { key: team.key } : {}) }]),
      ),
  );
  const [events, setEvents] = useState<Set<LinearEventSelection>>(() => new Set(savedEvents));
  const [dirty, setDirty] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!expanded || teams) return;
    let active = true;
    void listLinearTeamsAction(integrationId).then(
      (result) => {
        if (active) setTeams(result);
      },
      (error: unknown) => {
        if (active) setTeams({ ok: false, error: errorMessage(error, "Teams could not load.") });
      },
    );
    return () => {
      active = false;
    };
  }, [expanded, integrationId, teams]);

  const summary =
    selection.size === 0
      ? "No teams selected yet — nothing is ingested until you choose some."
      : `${selection.size} team${selection.size === 1 ? "" : "s"} and ${events.size} event${events.size === 1 ? "" : "s"} selected.`;

  if (!expanded) {
    return (
      <CollapsedScopePicker
        summary={summary}
        action="Choose teams and events"
        canConfigure={canConfigure}
        onExpand={() => setExpanded(true)}
      />
    );
  }

  const query = search.trim().toLowerCase();
  const teamOptions = (teams?.ok ? teams.teams : []).filter(
    (team) =>
      !query ||
      team.name.toLowerCase().includes(query) ||
      (team.key ?? "").toLowerCase().includes(query),
  );

  const save = () => {
    startTransition(async () => {
      try {
        const updated = await upsertWikiSource({
          integrationId,
          provider: "linear",
          enabled: source?.enabled ?? true,
          config: {
            teams: [...selection].map(([id, team]) => ({ id, ...team })),
            events: [...events].map((id) => ({ id })),
          },
        });
        setDirty(false);
        onSaved(updated);
        toast.success("Linear teams updated.");
      } catch (error) {
        toast.error(errorMessage(error, "Linear source could not be updated."));
      }
    });
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border/70 pt-2">
      <ScopeSearch
        value={search}
        placeholder="Search teams"
        onChange={setSearch}
        onCollapse={() => setExpanded(false)}
      />
      {teams === null ? (
        <div className="px-1 py-1.5 text-[12px] text-ink-subtle">Loading teams…</div>
      ) : !teams.ok ? (
        <div className="px-1 py-1.5 text-[12px] text-warning">{teams.error}</div>
      ) : (
        <>
          <div className="flex max-h-[220px] flex-col gap-px overflow-y-auto rounded-md border border-border/70 p-1">
            {teamOptions.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] text-ink-subtle">No teams found.</div>
            ) : (
              teamOptions.map((team) => (
                <label
                  key={team.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
                >
                  <input
                    type="checkbox"
                    checked={selection.has(team.id)}
                    onChange={() => {
                      setDirty(true);
                      setSelection((current) =>
                        toggleMapValue(current, team.id, {
                          name: team.name,
                          ...(team.key ? { key: team.key } : {}),
                        }),
                      );
                    }}
                    className="accent-ink"
                  />
                  <span className="min-w-0 flex-1 truncate">{team.name}</span>
                  {team.key ? (
                    <span className="shrink-0 text-[11px] text-ink-subtle">{team.key}</span>
                  ) : null}
                </label>
              ))
            )}
          </div>
          <div className="grid grid-cols-1 gap-px rounded-md border border-border/70 p-1 sm:grid-cols-2">
            {LINEAR_EVENT_OPTIONS.map((option) => (
              <label
                key={option.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
              >
                <input
                  type="checkbox"
                  checked={events.has(option.id)}
                  onChange={() => {
                    setDirty(true);
                    setEvents((current) => toggleSetValue(current, option.id));
                  }}
                  className="accent-ink"
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          {teams.partial ? (
            <p className="text-[11.5px] leading-4 text-ink-subtle">
              Some teams could not be loaded from Linear — try again in a minute.
            </p>
          ) : null}
        </>
      )}
      <ScopeSaveButton dirty={dirty} pending={isPending} label="Save Linear source" onSave={save} />
    </div>
  );
}

function CollapsedScopePicker({
  summary,
  action,
  canConfigure,
  onExpand,
}: {
  summary: string;
  action: string;
  canConfigure: boolean;
  onExpand: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-2">
      <p className="text-[11.5px] leading-4 text-ink-subtle">{summary}</p>
      {canConfigure ? (
        <button
          type="button"
          onClick={onExpand}
          className="shrink-0 rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-surface-hover"
        >
          {action}
        </button>
      ) : null}
    </div>
  );
}

function ScopeSearch({
  value,
  placeholder,
  onChange,
  onCollapse,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onCollapse: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <Search
          size={13}
          strokeWidth={2}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-subtle"
        />
        <input
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="w-full rounded-md border border-border/70 bg-transparent py-1 pl-7 pr-2 text-[12.5px] text-ink placeholder:text-ink-subtle focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
        />
      </div>
      <button
        type="button"
        onClick={onCollapse}
        className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
      >
        Collapse
      </button>
    </div>
  );
}

function ScopeSaveButton({
  dirty,
  pending,
  label,
  onSave,
}: {
  dirty: boolean;
  pending: boolean;
  label: string;
  onSave: () => void;
}) {
  if (!dirty) return null;
  return (
    <div className="flex justify-end">
      <button
        type="button"
        disabled={pending}
        onClick={onSave}
        className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
      >
        {pending ? "Saving…" : label}
      </button>
    </div>
  );
}

function githubReposFromConfig(config: Record<string, unknown> | undefined) {
  const value = config?.repos;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return [];
    const fullName = typeof record.fullName === "string" ? record.fullName.trim() : "";
    return [{ id, fullName: fullName || id }];
  });
}

function githubEventsFromConfig(config: Record<string, unknown> | undefined) {
  const known = new Set(GITHUB_EVENT_OPTIONS.map((option) => option.id));
  if (!Array.isArray(config?.events)) return known;
  return new Set(
    config.events.filter(
      (entry): entry is GitHubActivityEventType =>
        typeof entry === "string" && known.has(entry as GitHubActivityEventType),
    ),
  );
}

function linearTeamsFromConfig(config: Record<string, unknown> | undefined) {
  const value = config?.teams;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return [];
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const key = typeof record.key === "string" ? record.key.trim() : "";
    return [{ id, name: name || id, ...(key ? { key } : {}) }];
  });
}

function linearEventsFromConfig(config: Record<string, unknown> | undefined) {
  if (!Array.isArray(config?.events)) return LINEAR_EVENT_OPTIONS.map((option) => option.id);
  const allowed = new Set(LINEAR_EVENT_OPTIONS.map((option) => option.id));
  const events = new Set<LinearEventSelection>();
  for (const entry of config.events) {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).id
          : null;
    if (typeof id === "string" && allowed.has(id as LinearEventSelection)) {
      events.add(id as LinearEventSelection);
    }
  }
  return [...events];
}

function toggleMapValue<T>(current: Map<string, T>, id: string, value: T) {
  const next = new Map(current);
  if (next.has(id)) next.delete(id);
  else next.set(id, value);
  return next;
}

function toggleSetValue<T>(current: Set<T>, value: T) {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
