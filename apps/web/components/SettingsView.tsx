"use client";

import { Check, LogOut } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { updateWorkspaceName } from "@/lib/workspaces/actions";

type Props = {
  profile: {
    name: string;
    email: string;
    avatarUrl: string | null;
    initials: string;
  };
  workspace: {
    name: string;
    createdAt: string;
  };
};

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-[#eaeae6] py-7 first:border-t-0 first:pt-0">
      <div className="grid grid-cols-[200px_1fr] gap-8">
        <div>
          <h2 className="text-[13px] font-semibold tracking-[-0.005em] text-ink">{title}</h2>
          {description && (
            <p className="mt-1 text-[12px] leading-5 text-ink-muted">{description}</p>
          )}
        </div>
        <div className="flex flex-col gap-4">{children}</div>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
        {label}
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function ReadOnly({ value }: { value: string }) {
  return (
    <div className="rounded-md border border-[#e6e6e3] bg-white/60 px-2.5 py-1.5 text-[13px] text-ink/85">
      {value}
    </div>
  );
}

function ProfileAvatar({ avatarUrl, initials }: { avatarUrl: string | null; initials: string }) {
  if (avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt=""
        className="h-12 w-12 rounded-full object-cover ring-1 ring-black/[0.06]"
      />
    );
  }
  return (
    <div
      aria-hidden
      className="flex h-12 w-12 items-center justify-center rounded-full text-[14px] font-semibold text-white ring-1 ring-black/[0.06]"
      style={{
        background: "radial-gradient(circle at 30% 30%, #c9d9ff 0%, #3b5bdb 35%, #0b1224 80%)",
      }}
    >
      {initials}
    </div>
  );
}

function WorkspaceNameForm({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const dirty = value.trim() !== initial && value.trim().length > 0;

  const submit = (next: string) => {
    setError(null);
    startTransition(async () => {
      const res = await updateWorkspaceName(next);
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 1800);
      } else {
        setError(res.error);
      }
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty || isPending) return;
        submit(value);
      }}
      className="flex items-center gap-2"
    >
      <input
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
        maxLength={80}
        className="h-8 flex-1 rounded-md border border-[#e6e6e3] bg-white px-2.5 text-[13px] text-ink outline-none transition-colors focus:border-ink/30 focus:ring-1 focus:ring-ink/15"
      />
      <button
        type="submit"
        disabled={!dirty || isPending}
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#111] px-3 text-[12.5px] font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-black disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? "Saving…" : "Save"}
      </button>
      {saved && (
        <span className="inline-flex items-center gap-1 text-[12px] text-[#1f7a3a]">
          <Check size={13} strokeWidth={2} />
          Saved
        </span>
      )}
      {error && <span className="text-[12px] text-[#b42318]">{error}</span>}
    </form>
  );
}

export default function SettingsView({ profile, workspace }: Props) {
  return (
    <main className="relative flex h-full flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-8 pb-24 pt-10">
        <div>
          <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink">Settings</h1>
          <p className="mt-1 text-[13px] tracking-[-0.005em] text-ink-muted">
            Manage your profile and workspace.
          </p>
        </div>

        <div className="mt-8">
          <Section title="Profile" description="Managed by your identity provider (WorkOS).">
            <div className="flex items-center gap-3">
              <ProfileAvatar avatarUrl={profile.avatarUrl} initials={profile.initials} />
              <div className="min-w-0">
                <div className="truncate text-[14px] font-medium text-ink">{profile.name}</div>
                <div className="truncate text-[12.5px] text-ink-muted">{profile.email}</div>
              </div>
            </div>
            <Field label="Email">
              <ReadOnly value={profile.email} />
            </Field>
          </Section>

          <Section title="Workspace" description="Visible to everyone in this workspace.">
            <Field label="Workspace name">
              <WorkspaceNameForm initial={workspace.name} />
            </Field>
            <Field label="Created">
              <ReadOnly value={workspace.createdAt} />
            </Field>
          </Section>

          <Section title="Account" description="Sign out of all sessions for this device.">
            <Link
              href="/auth/sign-out"
              className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-[#e6e6e3] bg-white px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-[#f5f5f1]"
            >
              <LogOut size={13} strokeWidth={1.9} />
              Log out
            </Link>
          </Section>
        </div>
      </div>
    </main>
  );
}
