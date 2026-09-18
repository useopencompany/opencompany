"use client";

import type { CompanyAgentDto } from "@opencompany/protocol";
import { Button } from "@opencompany/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { Input } from "@opencompany/ui/components/input";
import { toast } from "@opencompany/ui/components/sonner";
import { Bot, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { EmptyState, formatRelativeTime } from "@/components/Routes";
import { StatusDot } from "@/components/StatusDot";
import { createCompanyAgent } from "@/lib/company-agent-commands";

/**
 * Every agent in the workspace, with the one fact that decides whether a run will work: who owns
 * it. An agent nobody owns any more is called out here rather than failing quietly at run time.
 */
export function CompanyAgentsList({
  agents,
  ownerNames,
}: {
  agents: CompanyAgentDto[];
  /** Owner WorkOS id to display name. `null` when the member list could not be loaded. */
  ownerNames: Record<string, string> | null;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <main className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink">
      <div className="flex min-h-0 w-full flex-1 justify-center overflow-y-auto px-6">
        <div className="flex w-full max-w-[1040px] flex-col gap-8 pb-24 pt-10 sm:pt-12">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-col gap-1.5">
              <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-ink">
                Company agents
              </h1>
              <p className="text-[13px] leading-5 text-ink-subtle">
                Named teammates with a standing job. Each one has an owner whose connected accounts
                it works with, and everyone in the workspace can run it and read what it did.
              </p>
            </div>
            <Button size="sm" className="shadow-sm shrink-0" onClick={() => setCreating(true)}>
              <Plus size={14} strokeWidth={2} />
              New agent
            </Button>
          </header>

          <section aria-labelledby="agent-list-heading" className="flex min-w-0 flex-col gap-3">
            <h2 id="agent-list-heading" className="sr-only">
              Company agent list
            </h2>
            {agents.length === 0 ? (
              <EmptyState
                icon={Bot}
                title="No agents yet"
                description="Create an agent for a job that keeps coming back — reviewing pull requests, triaging the inbox, writing the Monday update. Tell it what good looks like, pick when it wakes up, and it reports in Slack."
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border bg-surface">
                <table className="w-full min-w-[720px] table-fixed text-left">
                  <caption className="sr-only">Company agents and their last run</caption>
                  <colgroup>
                    <col className="w-[38%]" />
                    <col className="w-[22%]" />
                    <col className="w-[18%]" />
                    <col className="w-[22%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-border-subtle text-[11.5px] font-medium text-ink-subtle">
                      <th scope="col" className="px-4 py-3 font-medium">
                        Agent
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Owner
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Status
                      </th>
                      <th scope="col" className="px-3 py-3 font-medium">
                        Last run
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.map((agent) => (
                      <AgentRow
                        key={agent.id}
                        agent={agent}
                        ownerName={agentOwnerName(agent, ownerNames)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>

      {creating ? <NewAgentDialog onClose={() => setCreating(false)} /> : null}
    </main>
  );
}

function AgentRow({ agent, ownerName }: { agent: CompanyAgentDto; ownerName: string }) {
  const href = `/agents/${encodeURIComponent(agent.slug)}`;
  return (
    <tr className="border-b border-border-subtle last:border-b-0 hover:bg-surface-hover">
      <td className="px-4 py-3 align-middle">
        <Link href={href} prefetch className="flex min-w-0 items-center gap-3">
          <AgentPhoto agent={agent} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13.5px] font-medium text-ink">{agent.name}</span>
            {agent.description.trim() ? (
              <span className="truncate text-[12px] text-ink-subtle">{agent.description}</span>
            ) : null}
          </span>
        </Link>
      </td>
      <td className="px-3 py-3 align-middle text-[12.5px] text-ink-subtle">
        {agent.ownerActive ? ownerName : <span className="text-danger">No active owner</span>}
      </td>
      <td className="px-3 py-3 align-middle">
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink">
          <StatusDot status={agent.status === "active" ? "active" : "draft"} />
          {agent.status === "active" ? "Active" : "Paused"}
        </span>
      </td>
      <td className="px-3 py-3 align-middle text-[12.5px] text-ink-subtle">
        {agent.lastRunAt ? formatRelativeTime(agent.lastRunAt) : "Never"}
      </td>
    </tr>
  );
}

function AgentPhoto({ agent }: { agent: CompanyAgentDto }) {
  if (agent.photoUrl) {
    // Workspace-authored URL on an arbitrary host, so Next's optimizer is deliberately not used.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={agent.photoUrl}
        alt=""
        className="h-7 w-7 shrink-0 rounded-md border border-border object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-muted text-ink-subtle"
    >
      <Bot size={14} strokeWidth={1.8} />
    </span>
  );
}

function NewAgentDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (submitting || !name.trim()) return;
    setSubmitting(true);
    try {
      const agent = await createCompanyAgent({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      router.push(`/agents/${encodeURIComponent(agent.slug)}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The agent could not be created.");
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !submitting ? onClose() : undefined)}>
      <DialogContent className="max-w-[440px] gap-5">
        <DialogHeader>
          <DialogTitle className="text-[15px]">New agent</DialogTitle>
          <DialogDescription className="text-[12.5px] leading-5 text-ink-subtle">
            You will own this agent. Its work runs on your connected accounts, and only you can
            change how it is set up.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            value={name}
            maxLength={64}
            placeholder="PR Reviewer"
            aria-label="Agent name"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
          <Input
            value={description}
            maxLength={1024}
            placeholder="What this agent is responsible for"
            aria-label="Agent summary"
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={submitting || !name.trim()} onClick={() => void submit()}>
            Create agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function agentOwnerName(agent: CompanyAgentDto, ownerNames: Record<string, string> | null) {
  if (!agent.ownerUserId) return "—";
  if (!ownerNames) return "";
  return ownerNames[agent.ownerUserId] ?? "Former member";
}
