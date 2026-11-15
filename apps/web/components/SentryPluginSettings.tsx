"use client";
import type { CompanySentryPluginDto, SentryProjectDto } from "@opencompany/protocol";
import { Button } from "@opencompany/ui/components/button";
import { Input } from "@opencompany/ui/components/input";
import { toast } from "@opencompany/ui/components/sonner";
import { useState } from "react";
import { PageContent } from "@/components/PageContent";
import {
  connectSentryAction,
  disconnectSentryAction,
  listSentryProjectsAction,
  saveSentrySettingsAction,
} from "@/lib/sentry-actions";
export function SentryPluginSettings({
  plugin: initial,
  projects: initialProjects,
  nextCursor: initialCursor = null,
  installation,
}: {
  plugin: CompanySentryPluginDto;
  projects: SentryProjectDto[];
  nextCursor?: string | null;
  installation?: { id: string; code: string };
}) {
  const [plugin, setPlugin] = useState(initial);
  const [cursor, setCursor] = useState(initialCursor);
  const [projects, setProjects] = useState(initialProjects);
  const [selected, setSelected] = useState(initial.connection?.selectedProjectIds ?? []);
  const [cooldown, setCooldown] = useState(initial.connection?.cooldownMinutes ?? 30);
  const [cap, setCap] = useState(initial.connection?.dailyCap ?? 25);
  const [modes, setModes] = useState(initial.connection?.capabilityModes ?? {});
  const [toolModes, setToolModes] = useState(initial.connection?.toolModes ?? {});
  const [region, setRegion] = useState<"us" | "eu">("us");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function perform(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sentry setup failed.");
    } finally {
      setPending(false);
    }
  }
  const connection = plugin.connection;
  return (
    <PageContent title="Sentry" contentClassName="max-w-[760px]">
      <div className="flex flex-col gap-6 text-sm">
        <p className="text-ink-subtle">
          Connect one Sentry organization for your workspace. Members share the projects an admin
          selects. Workflows investigate through opencompany agents.
        </p>
        {!plugin.configured ? (
          <p role="status">Sentry public integration credentials are not configured.</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-warning">
            {error}
          </p>
        ) : null}
        {installation && plugin.canManage ? (
          <div className="flex flex-col gap-3">
            <p>Connect this installation to the current workspace, then choose its projects.</p>
            <label>
              Organization region
              <select
                aria-label="Organization region"
                value={region}
                onChange={(event) => setRegion(event.target.value as "us" | "eu")}
                className="ml-3 rounded border border-border bg-canvas p-2"
              >
                <option value="us">US</option>
                <option value="eu">EU</option>
              </select>
            </label>
            <Button
              disabled={pending || !plugin.configured}
              onClick={() =>
                void perform(async () => {
                  const next = await connectSentryAction({
                    installationId: installation.id,
                    code: installation.code,
                    region,
                  });
                  setPlugin(next);
                  setSelected(next.connection?.selectedProjectIds ?? []);
                  setToolModes(next.connection?.toolModes ?? {});
                  const result = await listSentryProjectsAction(true);
                  setProjects(result.projects);
                  setCursor(result.nextCursor);
                  window.history.replaceState(null, "", "/plugins/company/sentry");
                })
              }
            >
              Connect to this workspace
            </Button>
          </div>
        ) : !connection || ["disconnected", "needs_reauth"].includes(connection.status) ? (
          plugin.canManage && plugin.installUrl ? (
            <Button onClick={() => window.location.assign(plugin.installUrl!)}>
              {connection?.status === "needs_reauth" ? "Reconnect Sentry" : "Install Sentry"}
            </Button>
          ) : (
            <p>Ask a workspace admin to connect Sentry.</p>
          )
        ) : null}
        {connection ? (
          <>
            <div className="rounded-xl border border-border p-4">
              <p>
                {connection.organizationSlug}, {connection.region.toUpperCase()}
              </p>
              <p>
                Connection status: {connection.status}
                {!connection.verifiedAt ? ", setup incomplete" : ""}
              </p>
              <p>
                Last received delivery:{" "}
                {connection.lastReceivedAt
                  ? new Date(connection.lastReceivedAt).toLocaleString()
                  : "None"}
              </p>
              <p>
                Event-driven Tasks today: {plugin.usage} / {connection.dailyCap}. UTC day.
              </p>
            </div>
            <fieldset disabled={!plugin.canManage || pending} className="flex flex-col gap-4">
              <legend className="mb-2 font-medium">Shared project access</legend>
              {projects.length === 0 ? (
                <p>No projects loaded. Complete installation or check Sentry read permissions.</p>
              ) : (
                projects.map((project) => (
                  <label key={project.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.includes(project.id)}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? [...selected, project.id]
                            : selected.filter((id) => id !== project.id),
                        )
                      }
                    />
                    {project.name}
                  </label>
                ))
              )}
              {plugin.canManage ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void perform(async () => {
                      const result = await listSentryProjectsAction(true, cursor ?? undefined);
                      setProjects(cursor ? [...projects, ...result.projects] : result.projects);
                      setCursor(result.nextCursor);
                    })
                  }
                >
                  {cursor ? "Load more projects" : "Reload projects"}
                </Button>
              ) : null}
              <label className="flex flex-col gap-1">
                Alert cooldown in minutes
                <Input
                  type="number"
                  min={0}
                  max={10080}
                  value={cooldown}
                  onChange={(event) => setCooldown(Number(event.target.value))}
                />
              </label>
              <p className="text-xs text-ink-subtle">
                Cooldown starts when a run starts. Regression bypasses cooldown. Concurrent
                investigations are still suppressed.
              </p>
              <label className="flex flex-col gap-1">
                Daily event-driven Task cap
                <Input
                  type="number"
                  min={0}
                  max={1000}
                  value={cap}
                  onChange={(event) => setCap(Number(event.target.value))}
                />
              </label>
              {["read", "write"].map((capability) => (
                <label key={capability} className="flex justify-between">
                  {capability === "read" ? "Investigation tools" : "Issue updates"}
                  <select
                    aria-label={`${capability} permission`}
                    value={modes[capability] ?? (capability === "read" ? "on" : "ask")}
                    onChange={(event) =>
                      setModes({
                        ...modes,
                        [capability]: event.target.value as "on" | "ask" | "off",
                      })
                    }
                    className="rounded border border-border bg-canvas px-3 py-1"
                  >
                    <option value="on">On</option>
                    <option value="ask">Ask</option>
                    <option value="off">Off</option>
                  </select>
                </label>
              ))}
              <details>
                <summary className="cursor-pointer">Individual tool permissions</summary>
                <div className="mt-3 flex flex-col gap-2">
                  {plugin.tools.map((tool) => (
                    <label key={tool.id} className="flex justify-between gap-3">
                      {tool.id.replaceAll("_", " ")}
                      <select
                        aria-label={`${tool.id} permission`}
                        value={toolModes[tool.id] ?? "inherit"}
                        onChange={(event) => {
                          const next = { ...toolModes };
                          if (event.target.value === "inherit") delete next[tool.id];
                          else next[tool.id] = event.target.value as "on" | "ask" | "off";
                          setToolModes(next);
                        }}
                        className="rounded border border-border bg-canvas px-3 py-1"
                      >
                        <option value="inherit">Use capability permission</option>
                        <option value="on">On</option>
                        <option value="ask">Ask</option>
                        <option value="off">Off</option>
                      </select>
                    </label>
                  ))}
                </div>
              </details>
              <p className="text-xs text-ink-subtle">
                Unattended issue updates require an admin to enable writes. Templates never resolve
                or archive issues automatically.
              </p>
              {plugin.canManage ? (
                <Button
                  disabled={selected.length === 0 || pending}
                  onClick={() =>
                    void perform(async () => {
                      setPlugin(
                        await saveSentrySettingsAction({
                          projectIds: selected,
                          cooldownMinutes: cooldown,
                          dailyCap: cap,
                          capabilityModes: modes,
                          toolModes,
                        }),
                      );
                      toast.success("Sentry settings saved.");
                    })
                  }
                >
                  Save and verify installation
                </Button>
              ) : (
                <p>Only workspace admins can change these settings.</p>
              )}
            </fieldset>
            {plugin.canManage ? (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => void perform(async () => setPlugin(await disconnectSentryAction()))}
              >
                Disconnect Sentry
              </Button>
            ) : null}
            <div>
              <h2 className="mb-3 font-medium">Recent delivery outcomes</h2>
              {plugin.outcomes.length === 0 ? (
                <p>No deliveries received yet.</p>
              ) : (
                <ul className="space-y-2">
                  {plugin.outcomes.map((outcome, index) => (
                    <li
                      key={`${outcome.id}-${index}`}
                      className="rounded-lg border border-border p-3"
                    >
                      <p>
                        {new Date(outcome.receivedAt).toLocaleString()} ·{" "}
                        {outcome.runStatus ?? outcome.status}
                      </p>
                      <p>{outcome.runReason ?? outcome.reason ?? "Awaiting enrichment"}</p>
                      {outcome.taskId ? <p>Task {outcome.taskId}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </div>
    </PageContent>
  );
}
