"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Blocks, CheckCircle2, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { useToast } from "@/components/ToastProvider";
import { useWorkspaceContext } from "@/components/WorkspaceContext";
import type { WorkspaceSkillPayload } from "@/lib/skills/workspace";
import {
  createWorkspaceSkill,
  deleteWorkspaceSkill,
  updateWorkspaceSkill,
} from "@/lib/skills/workspace-actions";

type Draft =
  | {
      mode: "new";
      name: string;
      description: string;
      body: string;
    }
  | {
      mode: "edit";
      skillId: string;
      name: string;
      description: string;
      body: string;
    };

function draftFromSkill(skill: WorkspaceSkillPayload): Draft {
  return {
    mode: "edit",
    skillId: skill.skillId,
    name: skill.name,
    description: skill.description,
    body: skill.body,
  };
}

function newDraft(): Draft {
  return {
    mode: "new",
    name: "",
    description: "",
    body: "",
  };
}

function syncLabel(skill: WorkspaceSkillPayload): string {
  if (skill.githubSyncStatus === "failed") return "Sync failed";
  if (skill.githubSyncStatus === "pending" || skill.githubSyncStatus === "syncing") {
    return "Syncing";
  }
  return "Synced";
}

export default function CompanySkillsView({
  initialSkills,
}: {
  initialSkills: WorkspaceSkillPayload[];
}) {
  const { workspaceId } = useWorkspaceContext();
  const queryClient = useQueryClient();
  const { showError, showToast } = useToast();
  const [skills, setSkills] = useState(initialSkills);
  const [draft, setDraft] = useState<Draft>(() =>
    initialSkills[0] ? draftFromSkill(initialSkills[0]) : newDraft(),
  );
  const [isPending, startTransition] = useTransition();

  const selectedSkill = useMemo(
    () => (draft.mode === "edit" ? skills.find((skill) => skill.skillId === draft.skillId) : null),
    [draft, skills],
  );
  const dirty = useMemo(() => {
    if (draft.mode === "new") {
      return Boolean(draft.name.trim() || draft.description.trim() || draft.body.trim());
    }
    if (!selectedSkill) return false;
    return (
      draft.name !== selectedSkill.name ||
      draft.description !== selectedSkill.description ||
      draft.body !== selectedSkill.body
    );
  }, [draft, selectedSkill]);

  function replaceSkill(next: WorkspaceSkillPayload) {
    setSkills((current) =>
      current
        .map((skill) => (skill.skillId === next.skillId ? next : skill))
        .sort((a, b) => a.name.localeCompare(b.name) || a.skillId.localeCompare(b.skillId)),
    );
    setDraft(draftFromSkill(next));
    queryClient.invalidateQueries({ queryKey: ["workspace-skills", workspaceId] });
  }

  function addSkill(next: WorkspaceSkillPayload) {
    setSkills((current) =>
      [...current, next].sort(
        (a, b) => a.name.localeCompare(b.name) || a.skillId.localeCompare(b.skillId),
      ),
    );
    setDraft(draftFromSkill(next));
    queryClient.invalidateQueries({ queryKey: ["workspace-skills", workspaceId] });
  }

  function saveDraft() {
    startTransition(async () => {
      const input = {
        name: draft.name,
        description: draft.description,
        body: draft.body,
      };
      const result =
        draft.mode === "new"
          ? await createWorkspaceSkill(input)
          : await updateWorkspaceSkill(draft.skillId, input);
      if (!result.ok) {
        showError(result.error, "Could not save skill");
        return;
      }
      if (draft.mode === "new") addSkill(result.skill);
      else replaceSkill(result.skill);
      showToast({ title: "Skill saved" });
    });
  }

  function deleteSelectedSkill() {
    if (draft.mode !== "edit" || !selectedSkill) return;
    if (!window.confirm(`Delete ${selectedSkill.name}?`)) return;
    startTransition(async () => {
      const result = await deleteWorkspaceSkill(selectedSkill.skillId);
      if (!result.ok) {
        const suffix = result.references?.length
          ? ` Referenced by: ${result.references.join(", ")}.`
          : "";
        showError(`${result.error}${suffix}`, "Could not delete skill");
        return;
      }
      const nextSkills = skills.filter((skill) => skill.skillId !== selectedSkill.skillId);
      setSkills(nextSkills);
      setDraft(nextSkills[0] ? draftFromSkill(nextSkills[0]) : newDraft());
      queryClient.invalidateQueries({ queryKey: ["workspace-skills", workspaceId] });
      showToast({ title: "Skill deleted" });
    });
  }

  const saveDisabled = isPending || !draft.name.trim() || !draft.description.trim() || !dirty;

  return (
    <main className="relative flex h-full flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 overflow-hidden">
        <aside className="hidden w-[280px] shrink-0 border-r border-border bg-surface/55 px-3 py-4 md:block">
          <div className="mb-3 flex items-center justify-between gap-3 px-1">
            <h1 className="text-[14px] font-semibold text-ink">Skills</h1>
            <button
              type="button"
              onClick={() => setDraft(newDraft())}
              disabled={isPending}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-ink/10 bg-ink px-2.5 text-[12px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.14)] hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Plus size={12.5} strokeWidth={2} />
              New
            </button>
          </div>

          <div className="space-y-1">
            {skills.length === 0 ? (
              <div className="rounded-md border border-dashed border-border bg-surface/40 px-3 py-5 text-[12px] leading-5 text-ink-muted">
                No company skills yet.
              </div>
            ) : (
              skills.map((skill) => {
                const active = draft.mode === "edit" && draft.skillId === skill.skillId;
                return (
                  <button
                    key={skill.skillId}
                    type="button"
                    onClick={() => setDraft(draftFromSkill(skill))}
                    className={`flex w-full flex-col rounded-md px-2.5 py-2 text-left transition-colors duration-150 ${
                      active
                        ? "bg-surface-active text-ink"
                        : "text-ink/90 hover:bg-surface-hover hover:text-ink"
                    }`}
                  >
                    <span className="truncate text-[13px] font-medium">{skill.name}</span>
                    <span className="mt-0.5 truncate font-mono text-[11px] text-ink-subtle">
                      @skill/{skill.skillId}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        <section className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[820px] px-5 pb-16 pt-8 md:px-8">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Blocks size={16} strokeWidth={1.8} className="text-ink-muted" />
                  <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">
                    {draft.mode === "new" ? "New skill" : draft.name || "Untitled skill"}
                  </h1>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-subtle">
                  {draft.mode === "edit" ? (
                    <>
                      <span className="font-mono">@skill/{draft.skillId}</span>
                      {selectedSkill ? <span>{syncLabel(selectedSkill)}</span> : null}
                    </>
                  ) : (
                    <span>Company skill</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDraft(newDraft())}
                  disabled={isPending}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60 md:hidden"
                >
                  <Plus size={13} strokeWidth={2} />
                  New
                </button>
                {draft.mode === "edit" ? (
                  <button
                    type="button"
                    onClick={deleteSelectedSkill}
                    disabled={isPending}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger-border bg-danger-bg px-3 text-[12.5px] font-medium text-danger hover:bg-danger-bg/80 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Trash2 size={13} strokeWidth={2} />
                    Delete
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={saveDraft}
                  disabled={saveDisabled}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink/10 bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.14)] hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isPending ? (
                    <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                  ) : dirty ? (
                    <Save size={13} strokeWidth={2} />
                  ) : (
                    <CheckCircle2 size={13} strokeWidth={2} />
                  )}
                  {isPending ? "Saving..." : dirty ? "Save" : "Saved"}
                </button>
              </div>
            </div>

            <div className="mb-5 md:hidden">
              <select
                value={draft.mode === "edit" ? draft.skillId : "__new"}
                onChange={(event) => {
                  if (event.target.value === "__new") {
                    setDraft(newDraft());
                    return;
                  }
                  const skill = skills.find((item) => item.skillId === event.target.value);
                  if (skill) setDraft(draftFromSkill(skill));
                }}
                className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[14px] text-ink outline-none focus:border-ink/30"
              >
                <option value="__new">New skill</option>
                {skills.map((skill) => (
                  <option key={skill.skillId} value={skill.skillId}>
                    {skill.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-ink-muted">Name</span>
                <input
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="Brand voice"
                  className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[14px] text-ink outline-none placeholder:text-ink-subtle/70 focus:border-ink/30"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-ink-muted">
                  Description
                </span>
                <input
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  placeholder="Use when writing company-facing copy."
                  className="h-9 w-full rounded-md border border-border bg-surface px-3 text-[14px] text-ink outline-none placeholder:text-ink-subtle/70 focus:border-ink/30"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-ink-muted">
                  Markdown
                </span>
                <textarea
                  value={draft.body}
                  onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                  placeholder={"# Brand voice\n\n- Write plainly.\n- Prefer concrete examples."}
                  rows={18}
                  className="min-h-[420px] w-full resize-y rounded-md border border-border bg-surface px-3 py-2.5 font-mono text-[13px] leading-5 text-ink outline-none placeholder:text-ink-subtle/70 focus:border-ink/30"
                />
              </label>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
