"use client";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  GitBranch,
  KeyRound,
  LoaderCircle,
  LogOut,
  Monitor,
  Moon,
  Sun,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { type BillingData, BillingPanel } from "@/components/billing/BillingPanel";
import { type ThemeMode, useTheme } from "@/components/ThemeProvider";
import {
  type CodexDeviceAuthFlow,
  disconnectWorkspaceCodexAuth,
  pollWorkspaceCodexDeviceAuth,
  startWorkspaceCodexDeviceAuth,
} from "@/lib/codex-auth/actions";
import type { WorkspaceCodexAuthSettings } from "@/lib/codex-auth/data";
import { removeAvatar, updateAvatar } from "@/lib/users/actions";
import { updateWorkspaceName } from "@/lib/workspaces/actions";

type Props = {
  profile: {
    name: string;
    email: string;
    avatarUrl: string | null;
    hasCustomAvatar: boolean;
    initials: string;
  };
  workspace: {
    name: string;
    createdAt: string;
    canManageSettings: boolean;
    sync: {
      hasRepo: boolean;
      lastSyncedAt: string | null;
      pendingCount: number;
      failedCount: number;
    };
  };
  billing: BillingData;
  codexAuth: WorkspaceCodexAuthSettings;
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
    <section className="border-t border-border-subtle py-7 first:border-t-0 first:pt-0">
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
    <div className="rounded-md border border-border bg-surface/60 px-2.5 py-1.5 text-[13px] text-ink/85">
      {value}
    </div>
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function sameCodexDeviceAuthFlow(current: CodexDeviceAuthFlow | null, next: CodexDeviceAuthFlow) {
  return (
    current?.id === next.id &&
    current.status === next.status &&
    current.userCode === next.userCode &&
    current.verificationUri === next.verificationUri &&
    current.statusReason === next.statusReason &&
    current.expiresAt === next.expiresAt
  );
}

const themeOptions: Array<{
  value: ThemeMode;
  label: string;
  icon: typeof Monitor;
}> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      className="inline-flex w-fit rounded-lg border border-border bg-surface p-1 shadow-[0_1px_2px_rgba(15,15,15,0.03)]"
      role="radiogroup"
      aria-label="Theme"
    >
      {themeOptions.map((option) => {
        const Icon = option.icon;
        const selected = theme === option.value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(option.value)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
              selected
                ? "bg-surface-active text-ink shadow-[0_1px_1px_rgba(15,15,15,0.05)]"
                : "text-ink-muted hover:bg-surface-hover hover:text-ink"
            }`}
          >
            <Icon size={13} strokeWidth={1.9} />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function WorkspaceState({ sync }: { sync: Props["workspace"]["sync"] }) {
  const failed = sync.failedCount > 0;
  const pending = sync.pendingCount > 0;

  return (
    <div className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
          <GitBranch size={15} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">
            Managed by opencompany through Git
          </div>
          <p className="mt-1 text-[12px] leading-5 text-ink-muted">
            Your workspace files are versioned automatically in a private Git-backed repository.
          </p>

          <div className="mt-3 flex items-center gap-1.5 text-[12px]">
            {failed ? (
              <>
                <AlertTriangle size={13} strokeWidth={1.8} className="shrink-0 text-danger" />
                <span className="font-medium text-danger">
                  {sync.failedCount} change{sync.failedCount === 1 ? "" : "s"} failed to sync —
                  retrying
                </span>
              </>
            ) : pending ? (
              <>
                <Clock size={13} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
                <span className="text-ink-muted">
                  {sync.pendingCount} change{sync.pendingCount === 1 ? "" : "s"} waiting to sync
                </span>
              </>
            ) : (
              <>
                <CheckCircle2 size={13} strokeWidth={1.8} className="shrink-0 text-success" />
                <span className="text-ink-muted">In sync</span>
              </>
            )}
          </div>

          <div className="mt-3 text-[11.5px] text-ink-subtle">
            {sync.hasRepo
              ? sync.lastSyncedAt
                ? `Last synced ${sync.lastSyncedAt}`
                : "Not synced yet"
              : "Git storage is being set up"}
          </div>
        </div>
      </div>
    </div>
  );
}

function CodexAuthSection({
  codexAuth,
  canManage,
}: {
  codexAuth: WorkspaceCodexAuthSettings;
  canManage: boolean;
}) {
  const router = useRouter();
  const [flow, setFlow] = useState<CodexDeviceAuthFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStartingFlow, setIsStartingFlow] = useState(false);
  const [isSubmitting, startSubmitTransition] = useTransition();
  const isConnected = codexAuth.status === "connected";
  const needsReauth = codexAuth.status === "needs_reauth";
  const isTerminalFlow =
    flow?.status === "completed" || flow?.status === "failed" || flow?.status === "expired";
  const isActiveFlow = Boolean(flow && !isTerminalFlow);
  const shouldPoll = Boolean(flow && !isTerminalFlow);
  const flowId = flow?.id ?? null;
  const showSetupPanel = isStartingFlow || Boolean(flow && flow.status !== "completed");
  const connectDisabled = !canManage || isSubmitting || isStartingFlow || isActiveFlow;

  useEffect(() => {
    if (!shouldPoll || !flowId) return;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await pollWorkspaceCodexDeviceAuth(flowId);
        if (cancelled) return;
        if (!result.ok) {
          setError(result.error);
          setIsStartingFlow(false);
          return;
        }
        setFlow((current) =>
          sameCodexDeviceAuthFlow(current, result.flow) ? current : result.flow,
        );
        setIsStartingFlow(false);
        if (result.flow.status === "completed") {
          router.refresh();
        }
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [flowId, router, shouldPoll]);

  function onConnect() {
    setError(null);
    setFlow(null);
    setIsStartingFlow(true);
    startSubmitTransition(async () => {
      const result = await startWorkspaceCodexDeviceAuth();
      if (!result.ok) {
        setIsStartingFlow(false);
        setError(result.error);
        return;
      }
      setIsStartingFlow(false);
      setFlow(result.flow);
    });
  }

  function onDisconnect() {
    setError(null);
    setIsStartingFlow(false);
    startSubmitTransition(async () => {
      const result = await disconnectWorkspaceCodexAuth();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setFlow(null);
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-border bg-surface/65 p-4 shadow-[0_1px_2px_rgba(15,15,15,0.03)]">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-canvas text-ink-muted">
          <KeyRound size={15} strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[13px] font-medium tracking-[-0.005em] text-ink">
              Codex subscription auth
            </div>
            <span
              className={`inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium ${
                isConnected
                  ? "border-success/25 bg-success/10 text-success"
                  : needsReauth
                    ? "border-warning/25 bg-warning/10 text-warning"
                    : "border-border bg-surface text-ink-muted"
              }`}
            >
              {isConnected ? "Connected" : needsReauth ? "Needs reauth" : "Not connected"}
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-5 text-ink-muted">
            This workspace shares one Codex account for Codex engine runs. Model usage is handled by
            the connected Codex subscription; workspace credits still cover sandbox compute.
          </p>
          {codexAuth.connectedByEmail && (
            <div className="mt-2 text-[11.5px] text-ink-subtle">
              Connected by {codexAuth.connectedByEmail}
              {codexAuth.lastValidatedAt
                ? ` · validated ${formatDateTime(codexAuth.lastValidatedAt)}`
                : ""}
            </div>
          )}
          {codexAuth.statusReason && (
            <div className="mt-2 text-[12px] text-warning">{codexAuth.statusReason}</div>
          )}

          {showSetupPanel && (
            <div className="mt-4 rounded-md border border-border bg-canvas p-3">
              <div className="text-[12px] font-medium text-ink">
                {isStartingFlow
                  ? "Starting Codex sign-in"
                  : flow?.status === "failed"
                    ? "Codex connection failed"
                    : flow?.status === "expired"
                      ? "Codex connection expired"
                      : flow?.verificationUri && flow.userCode
                        ? "Finish signing in to Codex"
                        : "Preparing Codex sign-in"}
              </div>
              {flow?.verificationUri && flow.userCode ? (
                <div className="mt-2 flex flex-col gap-2">
                  <a
                    href={flow.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted"
                  >
                    <ExternalLink size={13} strokeWidth={1.9} />
                    Open Codex sign-in
                  </a>
                  <div className="w-fit rounded-md border border-border bg-surface px-3 py-2 font-mono text-[18px] font-semibold tracking-[0.08em] text-ink">
                    {flow.userCode}
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex items-start gap-2 text-[12px] leading-5 text-ink-muted">
                  <LoaderCircle
                    size={13}
                    strokeWidth={1.8}
                    className="mt-0.5 shrink-0 animate-spin"
                  />
                  <span>
                    {isStartingFlow
                      ? "Creating a short-lived auth sandbox and starting Codex login."
                      : "Waiting for Codex to produce a device code. This can take a minute on a cold sandbox."}
                  </span>
                </div>
              )}
              {flow?.statusReason && (
                <div className="mt-2 text-[12px] text-ink-muted">{flow.statusReason}</div>
              )}
            </div>
          )}

          {error && <div className="mt-3 text-[12px] text-danger">{error}</div>}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onConnect}
              disabled={connectDisabled}
              className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {isStartingFlow || isActiveFlow ? (
                <LoaderCircle size={13} strokeWidth={1.9} className="animate-spin" />
              ) : (
                <KeyRound size={13} strokeWidth={1.9} />
              )}
              {isStartingFlow || isActiveFlow
                ? "Signing in..."
                : isConnected
                  ? "Reconnect Codex"
                  : "Connect Codex"}
            </button>
            {codexAuth.status && (
              <button
                type="button"
                onClick={onDisconnect}
                disabled={!canManage || isSubmitting}
                className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-45"
              >
                Disconnect
              </button>
            )}
            {!canManage && (
              <span className="text-[12px] text-ink-subtle">
                Only workspace admins can manage Codex authentication.
              </span>
            )}
          </div>
        </div>
      </div>
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
      className="flex h-12 w-12 items-center justify-center rounded-full text-[14px] font-semibold text-canvas ring-1 ring-black/[0.06]"
      style={{
        background: "radial-gradient(circle at 30% 30%, #c9d9ff 0%, #3b5bdb 35%, #0b1224 80%)",
      }}
    >
      {initials}
    </div>
  );
}

// Resize any picked image to a centered 256px square and encode as webp on the client,
// so we never ship a multi-MB original to the server or store one in Postgres.
async function resizeImageToSquareWebp(
  file: File,
): Promise<{ dataBase64: string; previewUrl: string }> {
  const SIZE = 256;
  const bitmap = await createImageBitmap(file);
  if (!bitmap.width || !bitmap.height) {
    bitmap.close?.();
    throw new Error("Invalid image dimensions.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available.");
  const scale = Math.max(SIZE / bitmap.width, SIZE / bitmap.height);
  const drawW = bitmap.width * scale;
  const drawH = bitmap.height * scale;
  ctx.drawImage(bitmap, (SIZE - drawW) / 2, (SIZE - drawH) / 2, drawW, drawH);
  bitmap.close?.();
  // The server derives the real mime from magic bytes, so we just hand over the bytes.
  // (Browsers without webp encode fall back to png, which the server also accepts.)
  const dataUrl = canvas.toDataURL("image/webp", 0.9);
  const dataBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { dataBase64, previewUrl: dataUrl };
}

function AvatarForm({
  avatarUrl,
  initials,
  hasCustomAvatar,
}: {
  avatarUrl: string | null;
  initials: string;
  hasCustomAvatar: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const hasPhoto = (hasCustomAvatar && !removed) || Boolean(preview);
  const shownUrl = removed ? null : (preview ?? avatarUrl);

  const onPick = async (file: File) => {
    setError(null);
    let resized: { dataBase64: string; previewUrl: string };
    try {
      resized = await resizeImageToSquareWebp(file);
    } catch {
      setError("Could not process that image.");
      return;
    }
    setPreview(resized.previewUrl);
    setRemoved(false);
    startTransition(async () => {
      const res = await updateAvatar({ dataBase64: resized.dataBase64 });
      if (res.ok) {
        router.refresh();
      } else {
        setError(res.error);
        setPreview(null);
      }
    });
  };

  const onRemove = () => {
    setError(null);
    startTransition(async () => {
      const res = await removeAvatar();
      if (res.ok) {
        setPreview(null);
        setRemoved(true);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  };

  return (
    <div className="flex items-center gap-4">
      <ProfileAvatar avatarUrl={shownUrl} initials={initials} />
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onPick(file);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={isPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? "Saving…" : hasPhoto ? "Change photo" : "Upload photo"}
          </button>
          {hasPhoto && !isPending && (
            <button
              type="button"
              onClick={onRemove}
              className="inline-flex h-8 items-center rounded-md px-2.5 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:text-ink"
            >
              Remove
            </button>
          )}
        </div>
        {error ? (
          <span className="text-[12px] text-danger">{error}</span>
        ) : (
          <span className="text-[11.5px] text-ink-subtle">
            PNG, JPEG or WebP. Square images look best.
          </span>
        )}
      </div>
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
        className="h-8 flex-1 rounded-md border border-border bg-surface px-2.5 text-[13px] text-ink outline-none transition-colors focus:border-ink/30 focus:ring-1 focus:ring-ink/15"
      />
      <button
        type="submit"
        disabled={!dirty || isPending}
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[12.5px] font-medium text-canvas shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? "Saving…" : "Save"}
      </button>
      {saved && (
        <span className="inline-flex items-center gap-1 text-[12px] text-success">
          <Check size={13} strokeWidth={2} />
          Saved
        </span>
      )}
      {error && <span className="text-[12px] text-danger">{error}</span>}
    </form>
  );
}

export default function SettingsView({ profile, workspace, billing, codexAuth }: Props) {
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
          <Section
            title="Profile"
            description="Shown on your profile. Email is managed by your identity provider."
          >
            {/* key resets the optimistic preview/removed state once the server
                refresh delivers a new avatarUrl (e.g. the IdP avatar after a remove). */}
            <AvatarForm
              key={profile.avatarUrl ?? "none"}
              avatarUrl={profile.avatarUrl}
              initials={profile.initials}
              hasCustomAvatar={profile.hasCustomAvatar}
            />
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium text-ink">{profile.name}</div>
              <div className="truncate text-[12.5px] text-ink-muted">{profile.email}</div>
            </div>
            <Field label="Email">
              <ReadOnly value={profile.email} />
            </Field>
          </Section>

          <Section title="Appearance" description="Choose the color mode for this device.">
            <Field label="Theme">
              <AppearanceSection />
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

          <Section
            title="Workspace state"
            description="How this workspace is stored and versioned."
          >
            <WorkspaceState sync={workspace.sync} />
          </Section>

          <Section
            title="Codex"
            description="Use a workspace Codex subscription for Codex engine sessions."
          >
            <CodexAuthSection codexAuth={codexAuth} canManage={workspace.canManageSettings} />
          </Section>

          <Section title="Billing" description="Workspace credits are stored in USD cents.">
            <BillingPanel billing={billing} sessionPathPrefix="/company" />
          </Section>

          <Section title="Account" description="Sign out of all sessions for this device.">
            <a
              href="/auth/sign-out"
              className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12.5px] font-medium text-ink transition-colors duration-150 hover:bg-surface-muted"
            >
              <LogOut size={13} strokeWidth={1.9} />
              Log out
            </a>
          </Section>
        </div>
      </div>
    </main>
  );
}
