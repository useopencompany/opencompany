import { getWorkspaceSlackChannel } from "@/lib/slack/data";

// Reuses the onboarding call booking link (see OnboardingForm) as the no-Slack fallback.
const BOOK_CALL_URL = "https://cal.com/team/opencompany/intro-call?overlayCalendar=true";

// Server component: reads the workspace's Slack support channel and shows a single
// state-appropriate card. It NEVER renders a dead "Connect on Slack" button — failed
// or missing rows degrade to the booking fallback only (max-2-buttons: one real
// button, the booking is a quiet link).
export default async function SlackSupportCard({ workspaceId }: { workspaceId: string }) {
  const channel = await getWorkspaceSlackChannel(workspaceId);
  if (!channel) return null;

  if (channel.status === "active" && channel.inviteUrl) {
    return (
      <section className="mt-8 rounded-lg border border-border bg-surface p-4 text-left">
        <h2 className="text-[13px] font-semibold text-ink">Connect with our team on Slack</h2>
        <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
          We opened a private channel between your team and ours — your direct line to us.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <a
            href={channel.inviteUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center rounded-md bg-ink px-3 text-[12px] font-medium text-canvas transition-colors hover:bg-ink/85"
          >
            Connect on Slack
          </a>
          <a
            href={BOOK_CALL_URL}
            target="_blank"
            rel="noreferrer"
            className="text-[12px] text-ink-subtle transition-colors hover:text-ink"
          >
            No Slack? Book a call
          </a>
        </div>
      </section>
    );
  }

  if (channel.status === "pending") {
    return (
      <section className="mt-8 rounded-lg border border-border bg-surface p-4 text-left">
        <h2 className="text-[13px] font-semibold text-ink">Setting up your Slack channel…</h2>
        <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
          We&rsquo;re opening your private support channel — the invite arrives by email shortly.
        </p>
        <a
          href={BOOK_CALL_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block text-[12px] text-ink-subtle transition-colors hover:text-ink"
        >
          Prefer to talk? Book a call
        </a>
      </section>
    );
  }

  // failed / no invite → booking fallback only, never a broken Slack button.
  return (
    <section className="mt-8 rounded-lg border border-border bg-surface p-4 text-left">
      <h2 className="text-[13px] font-semibold text-ink">Need a hand getting started?</h2>
      <a
        href={BOOK_CALL_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-block text-[12px] text-ink-subtle transition-colors hover:text-ink"
      >
        Book a call with the OC team
      </a>
    </section>
  );
}
