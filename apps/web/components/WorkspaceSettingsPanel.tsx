"use client";

import { toast } from "@opencompany/ui/components/sonner";
import { Mail, Trash2, UserRound, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { GoatSettingsContent } from "@/components/GoatSettingsChrome";
import {
  type GoatWorkspaceInvitationView,
  type GoatWorkspaceMemberView,
  inviteToGoatWorkspaceAction,
  removeGoatWorkspaceMemberAction,
  revokeGoatWorkspaceInvitationAction,
  updateGoatWorkspaceNameAction,
} from "@/lib/workspace-actions";

type WorkspaceSettings = {
  workspace: { id: string; name: string };
  role: "admin" | "member";
  plan: "hobby" | "pro";
  memberCap: number;
  members: GoatWorkspaceMemberView[];
  invitations: GoatWorkspaceInvitationView[];
};

export function WorkspaceSettingsPanel({ initial }: { initial: WorkspaceSettings }) {
  const router = useRouter();
  const isAdmin = initial.role === "admin";
  const seatsUsed = initial.members.length + initial.invitations.length;
  const overCap = initial.members.length > initial.memberCap;
  const [name, setName] = useState(initial.workspace.name);
  const [inviteEmail, setInviteEmail] = useState("");
  const [isPending, startTransition] = useTransition();

  const saveName = () => {
    if (name.trim() === initial.workspace.name) return;
    startTransition(async () => {
      const result = await updateGoatWorkspaceNameAction(name);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Workspace renamed.");
      router.refresh();
    });
  };

  const invite = () => {
    const email = inviteEmail.trim();
    if (!email) return;
    startTransition(async () => {
      const result = await inviteToGoatWorkspaceAction(email);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setInviteEmail("");
      toast.success(`Invitation sent to ${email}.`);
      router.refresh();
    });
  };

  const revokeInvitation = (invitationId: string) => {
    startTransition(async () => {
      const result = await revokeGoatWorkspaceInvitationAction(invitationId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.refresh();
    });
  };

  const removeMember = (member: GoatWorkspaceMemberView) => {
    startTransition(async () => {
      const result = await removeGoatWorkspaceMemberAction(member.userWorkosId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.warning) toast.warning(result.warning);
      else toast.success(`Removed ${member.name}.`);
      router.refresh();
    });
  };

  return (
    <GoatSettingsContent
      title="Members"
      description="Manage the people who share this workspace and its brains."
    >
      <div
        className={`rounded-lg border px-3 py-2 text-[12.5px] leading-5 ${
          overCap
            ? "border-amber-500/30 bg-amber-500/10 text-ink"
            : "border-border bg-surface-muted/40 text-ink-subtle"
        }`}
      >
        {overCap ? (
          <>
            This workspace has {initial.members.length} members, over the limit of{" "}
            {initial.memberCap}. Inviting is disabled until you are under the limit.
          </>
        ) : (
          <>
            {seatsUsed} of {initial.memberCap} members used (members plus pending invites).
          </>
        )}
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Name
        </h2>
        <div className="flex items-center gap-2">
          <input
            value={name}
            disabled={!isAdmin}
            onChange={(event) => setName(event.target.value)}
            onBlur={saveName}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveName();
            }}
            className="flex-1 rounded-md border border-ink/10 bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-ink/25 disabled:opacity-70"
          />
        </div>
      </section>

      {isAdmin ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
            Invite people
          </h2>
          <div className="flex items-center gap-2">
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") invite();
              }}
              placeholder="teammate@company.example"
              className="flex-1 rounded-md border border-ink/10 bg-canvas px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-ink/25"
            />
            <button
              type="button"
              disabled={isPending || !inviteEmail.trim() || seatsUsed >= initial.memberCap}
              onClick={invite}
              className="rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-canvas transition-opacity disabled:opacity-50"
            >
              Invite
            </button>
          </div>
          <p className="text-[11.5px] leading-4 text-ink-subtle">
            Invited people get an email and join this workspace when they sign up. They see every
            brain that is open to the workspace.
          </p>
        </section>
      ) : null}

      {initial.invitations.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
            Pending invitations
          </h2>
          {initial.invitations.map((invitation) => (
            <div key={invitation.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
              <Mail size={14} strokeWidth={1.75} className="shrink-0 text-ink/50" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink/90">
                {invitation.email}
              </span>
              {isAdmin ? (
                <button
                  type="button"
                  aria-label={`Revoke invitation for ${invitation.email}`}
                  disabled={isPending}
                  onClick={() => revokeInvitation(invitation.id)}
                  className="rounded-md p-1 text-ink/40 transition-colors hover:bg-surface-hover hover:text-ink/80"
                >
                  <X size={13} strokeWidth={1.75} />
                </button>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-1">
        <h2 className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.07em] text-ink-subtle">
          Members
        </h2>
        {initial.members.map((member) => (
          <div
            key={member.userWorkosId}
            className="flex items-center gap-2.5 rounded-md px-2 py-1.5"
          >
            {member.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={member.avatarUrl}
                alt=""
                className="h-6 w-6 shrink-0 rounded-full bg-surface-muted object-cover"
              />
            ) : (
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-muted">
                <UserRound size={13} strokeWidth={1.75} className="text-ink/60" />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] leading-tight text-ink/90">
                {member.name}
              </span>
              <span className="block truncate text-[11px] leading-tight text-ink-subtle">
                {member.email}
              </span>
            </span>
            <span className="shrink-0 text-[11px] uppercase tracking-wide text-ink-subtle">
              {member.role}
            </span>
            {isAdmin ? (
              <button
                type="button"
                aria-label={`Remove ${member.name}`}
                disabled={isPending}
                onClick={() => removeMember(member)}
                className="rounded-md p-1 text-ink/40 transition-colors hover:bg-surface-hover hover:text-red-600"
              >
                <Trash2 size={13} strokeWidth={1.75} />
              </button>
            ) : null}
          </div>
        ))}
      </section>
    </GoatSettingsContent>
  );
}
