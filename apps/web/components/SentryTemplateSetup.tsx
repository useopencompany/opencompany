"use client";
import type { CompanySentryPluginDto, SentryProjectDto } from "@opencompany/protocol";
import { Button } from "@opencompany/ui/components/button";
import { Input } from "@opencompany/ui/components/input";
import { useEffect, useState } from "react";
import { listSentryProjectsAction, validateSentryFixAction } from "@/lib/sentry-actions";
import { prepareSentryTemplate } from "@/lib/sentry-template-setup";
import { supportedTimezones } from "@/lib/timezones";
import type { PreparedWorkflowTemplate, WorkflowTemplate } from "@/lib/workflow-templates";
import { ExactTagConditions } from "./SentryConditions";
export function SentryTemplateSetup({
  template,
  plugin,
  pending,
  onBack,
  onUse,
}: {
  template: WorkflowTemplate;
  plugin: CompanySentryPluginDto | null;
  pending: boolean;
  onBack: () => void;
  onUse: (prepared: PreparedWorkflowTemplate) => void;
}) {
  const [projects, setProjects] = useState<SentryProjectDto[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [environment, setEnvironment] = useState("");
  const [priority, setPriority] = useState("");
  const [tags, setTags] = useState<{ key: string; value: string }[]>([]);
  const [engine, setEngine] = useState<"codex" | "claude-code">("codex");
  const [repository, setRepository] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [time, setTime] = useState("09:00");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const projects: SentryProjectDto[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const result = await listSentryProjectsAction(false, cursor);
        projects.push(...result.projects);
        cursor = result.nextCursor ?? undefined;
        if (cursor && seen.has(cursor))
          throw new Error("Sentry project pagination did not advance.");
        if (cursor) seen.add(cursor);
      } while (cursor && !cancelled);
      return { projects };
    })()
      .then((result) => {
        if (!cancelled) setProjects(result.projects);
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Could not load Sentry projects.");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const project = projects?.find((project) => project.id === projectId);
  async function submit() {
    if (!project || !plugin?.connection) return;
    setChecking(true);
    setError(null);
    try {
      if (template.setup === "sentry-fix")
        await validateSentryFixAction({ engine, repository, baseBranch });
      onUse(
        prepareSentryTemplate(template, {
          integrationId: plugin.connection.integrationId,
          project,
          environment,
          priority,
          tags,
          engine,
          repository,
          baseBranch,
          time,
          timezone,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Template setup failed.");
    } finally {
      setChecking(false);
    }
  }
  const selectClass = "rounded-lg border border-border bg-canvas p-2 text-sm";
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        Project
        <select
          aria-label="Sentry project"
          value={projectId}
          className={selectClass}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">{projects ? "Select a project" : "Loading projects..."}</option>
          {projects?.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      {template.setup === "sentry-daily" ? (
        <>
          <label className="flex flex-col gap-1">
            Daily time
            <Input
              aria-label="Daily time"
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            Timezone
            <select
              aria-label="Schedule timezone"
              className={selectClass}
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            >
              {supportedTimezones().map((timezone) => (
                <option key={timezone} value={timezone}>
                  {timezone}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <>
          <p className="text-xs text-ink-subtle">
            Creation and regression triggers use the same conditions. All conditions must match one
            occurrence. An issue created in staging does not later qualify as a new production
            issue.
          </p>
          <label className="flex flex-col gap-1">
            Priority
            <select
              aria-label="Sentry priority"
              className={selectClass}
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            >
              <option value="">Any priority</option>
              {["high", "medium", "low"].map((priority) => (
                <option key={priority} value={priority}>
                  {priority}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-ink-subtle">
            Priority is Sentry&apos;s triage priority, not error severity.
          </p>
          <label className="flex flex-col gap-1">
            Environment
            <Input
              aria-label="Sentry environment"
              maxLength={256}
              value={environment}
              placeholder="Any environment"
              onChange={(event) => setEnvironment(event.target.value)}
            />
          </label>
          <ExactTagConditions
            value={tags.length ? { id: "exact-tags", name: "Exact tags", pairs: tags } : null}
            onChange={(value) => setTags(value?.pairs ?? [])}
          />
          {template.setup === "sentry-fix" ? (
            <>
              <label className="flex flex-col gap-1">
                Coding engine
                <select
                  aria-label="Coding engine"
                  className={selectClass}
                  value={engine}
                  onChange={(event) => setEngine(event.target.value as "codex" | "claude-code")}
                >
                  <option value="codex">Codex</option>
                  <option value="claude-code">Claude Code</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Repository
                <Input
                  aria-label="Fix repository"
                  value={repository}
                  placeholder="owner/repository"
                  onChange={(event) => setRepository(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                Base branch
                <Input
                  aria-label="Fix base branch"
                  value={baseBranch}
                  placeholder="Select an existing branch"
                  onChange={(event) => setBaseBranch(event.target.value)}
                />
              </label>
              <p className="text-xs text-ink-subtle">
                Setup checks repository and branch access. Activation also requires the chosen
                coding account and GitHub permissions to push a branch and create a PR. Permissions
                stay under your control.
              </p>
            </>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="text-warning">
          {error}
        </p>
      ) : null}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack} disabled={pending || checking}>
          All templates
        </Button>
        <Button onClick={() => void submit()} disabled={!project || pending || checking}>
          Create draft
        </Button>
      </div>
    </div>
  );
}
