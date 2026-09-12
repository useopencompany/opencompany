"use client";

import type { WikiAccessDetailsDto, WikiDto } from "@opencompany/protocol";
import { toast } from "@opencompany/ui/components/sonner";
import { useEffect, useState } from "react";
import { getWikiAccess, setWikiAccess, updateWiki } from "@/lib/wikis";

/**
 * A wiki's name, its instructions, and who can reach it.
 *
 * Access has two stored states but reads as three, because "restricted with nobody invited" and
 * "restricted with a co-founder invited" are different intentions even though they are one column.
 * The server always keeps the acting user as a member of a restricted wiki, so the invited set is
 * derived from everyone *other* than the reader.
 */
type AccessMode = "workspace" | "private" | "shared";

function accessModeOf(details: WikiAccessDetailsDto, currentUserWorkosId: string): AccessMode {
  if (details.access === "workspace") return "workspace";
  return details.memberIds.some((id) => id !== currentUserWorkosId) ? "shared" : "private";
}

/** Whether the picker differs from what the server last reported, so an unchanged visit is silent. */
function accessChanged(
  details: WikiAccessDetailsDto,
  currentUserWorkosId: string,
  mode: AccessMode,
  invited: ReadonlySet<string>,
): boolean {
  if (accessModeOf(details, currentUserWorkosId) !== mode) return true;
  if (mode !== "shared") return false;
  const current = details.memberIds.filter((id) => id !== currentUserWorkosId);
  return current.length !== invited.size || current.some((id) => !invited.has(id));
}

export function WikiSettings({
  wiki,
  currentUserWorkosId,
  onClose,
  onSaved,
}: {
  wiki: WikiDto;
  currentUserWorkosId: string;
  onClose: () => void;
  onSaved: (wiki: WikiDto) => void;
}) {
  const [name, setName] = useState(wiki.name);
  const [instructions, setInstructions] = useState(wiki.instructions);
  const [details, setDetails] = useState<WikiAccessDetailsDto | null>(null);
  const [mode, setMode] = useState<AccessMode>(
    wiki.access === "workspace" ? "workspace" : "shared",
  );
  const [invited, setInvited] = useState<ReadonlySet<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getWikiAccess(wiki.id)
      .then((next) => {
        if (cancelled) return;
        setDetails(next);
        setMode(accessModeOf(next, currentUserWorkosId));
        setInvited(new Set(next.memberIds.filter((id) => id !== currentUserWorkosId)));
        setLoadError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(cause instanceof Error ? cause.message : "Wiki access could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [wiki.id, currentUserWorkosId]);

  const toggleInvite = (userId: string) => {
    setInvited((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("A wiki name is required.");
      return;
    }
    setSaving(true);
    // Two independent commands. The name and instructions go first, so a rejected access change
    // (restricting the default wiki) does not silently discard a rename made in the same visit --
    // and whatever did land is handed back even if the second command then fails, so the sidebar
    // never shows a name the server has already replaced.
    let saved = wiki;
    try {
      if (trimmed !== wiki.name || instructions !== wiki.instructions) {
        saved = await updateWiki(wiki.id, { name: trimmed, instructions });
      }
      if (
        details &&
        !wiki.isDefault &&
        accessChanged(details, currentUserWorkosId, mode, invited)
      ) {
        const updated = await setWikiAccess(wiki.id, {
          access: mode === "workspace" ? "workspace" : "restricted",
          memberIds: mode === "shared" ? [...invited] : [],
        });
        setDetails(updated);
        saved = { ...saved, access: updated.access };
      }
      toast.success("Wiki settings saved.");
      onClose();
    } catch (cause) {
      // The user's edits stay on screen so a failed save is retryable rather than retyped.
      toast.error(cause instanceof Error ? cause.message : "The wiki could not be saved.");
    } finally {
      onSaved(saved);
      setSaving(false);
    }
  };

  const roster = (details?.workspaceMembers ?? []).filter(
    (member) => member.id !== currentUserWorkosId,
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`${wiki.name} settings`}
    >
      <div className="flex max-h-[86vh] w-full max-w-[420px] flex-col gap-3 overflow-y-auto rounded-lg bg-canvas p-4 shadow-ring-xl">
        <div className="text-[14px] font-semibold text-ink">Wiki settings</div>

        <div className="flex flex-col gap-1">
          <label htmlFor="wiki-settings-name" className="text-[12px] font-medium text-ink-subtle">
            Name
          </label>
          <input
            id="wiki-settings-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            className="h-8 w-full rounded-md border border-border bg-canvas px-2 text-[13px] text-ink outline-none focus:border-border-strong"
          />
          {/* The slug is the wiki's URL and is deliberately immutable, so a rename never breaks a
              link someone already shared. */}
          <p className="text-[11.5px] leading-4 text-ink-faint">
            Its address stays <span className="text-ink-subtle">/wiki/{wiki.slug}</span>.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="wiki-settings-instructions"
            className="text-[12px] font-medium text-ink-subtle"
          >
            Instructions
          </label>
          <textarea
            id="wiki-settings-instructions"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={5}
            placeholder="How this wiki should be organised — the folder structure you want, what belongs here and what doesn't."
            className="w-full resize-y rounded-md border border-border bg-canvas px-2 py-1.5 text-[13px] leading-5 text-ink outline-none placeholder:text-ink-faint focus:border-border-strong"
          />
          <p className="text-[11.5px] leading-4 text-ink-faint">
            Guidance for agents writing here. Saved now; agents start following it when per-wiki
            instructions ship.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-ink-subtle">Access</span>
          {wiki.isDefault ? (
            <p className="rounded-md border border-border-subtle bg-surface px-2.5 py-2 text-[12px] leading-5 text-ink-muted">
              Everyone in the workspace can reach this wiki. It is where agents write when no wiki
              is named, so it stays open — create a separate wiki to share with specific people.
            </p>
          ) : loadError ? (
            <p role="alert" className="text-[12px] leading-5 text-danger">
              {loadError}
            </p>
          ) : (
            <>
              <AccessOption
                checked={mode === "workspace"}
                onSelect={() => setMode("workspace")}
                title="Workspace"
                description="Everyone in the workspace, now and later."
              />
              <AccessOption
                checked={mode === "private"}
                onSelect={() => setMode("private")}
                title="Private"
                description="Only you."
              />
              <AccessOption
                checked={mode === "shared"}
                onSelect={() => setMode("shared")}
                title="Shared"
                description="You and the people you invite."
              />
              {mode === "shared" ? (
                <div className="mt-1 flex max-h-[200px] flex-col gap-px overflow-y-auto rounded-md border border-border-subtle p-1">
                  {details === null ? (
                    <p role="status" className="px-2 py-1.5 text-[12px] text-ink-subtle">
                      Loading members…
                    </p>
                  ) : roster.length === 0 ? (
                    <p className="px-2 py-1.5 text-[12px] text-ink-subtle">
                      Nobody else is in this workspace yet.
                    </p>
                  ) : (
                    roster.map((member) => (
                      <label
                        key={member.id}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-ink/90 transition-colors hover:bg-surface-hover"
                      >
                        <input
                          type="checkbox"
                          checked={invited.has(member.id)}
                          onChange={() => toggleInvite(member.id)}
                          className="accent-ink"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {member.name || member.email}
                        </span>
                        <span className="shrink-0 text-[11px] text-ink-subtle">{member.role}</span>
                      </label>
                    ))
                  )}
                </div>
              ) : null}
              {/* Leaving Shared drops the invites rather than remembering them, so say so before
                  the save rather than after. */}
              {mode !== "shared" && invited.size > 0 ? (
                <p className="text-[11.5px] leading-4 text-ink-muted">
                  Saving removes {invited.size} invited {invited.size === 1 ? "person" : "people"}.
                </p>
              ) : null}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[13px] text-ink/70 transition-colors hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Local rather than shared with Brain's `VisibilityOption`: Brain is being retired, and coupling a
 * surface we are building to one we are removing would only have to be undone.
 */
function AccessOption({
  checked,
  onSelect,
  title,
  description,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={checked}
      className={`flex flex-col items-start gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors ${
        checked ? "border-ink/30 bg-surface-active" : "border-ink/10 hover:bg-surface-hover"
      }`}
    >
      <span className="text-[13px] font-medium text-ink">{title}</span>
      <span className="text-[11.5px] leading-4 text-ink-subtle">{description}</span>
    </button>
  );
}
