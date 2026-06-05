import { INTRO_CALL_URL } from "@/lib/booking";
import { getWorkspaceSlackChannel } from "@/lib/slack/data";

// Reuses the onboarding call booking link (see OnboardingForm) as the no-Slack fallback.
const BOOK_CALL_URL = INTRO_CALL_URL;

// Only let an https URL reach an href — never javascript:/data:/etc. The value is
// stored from Slack's API, but we don't render an unvalidated scheme into the DOM.
function safeHttpsUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// Server component: reads the workspace's Slack support channel and shows a single
// state-appropriate card. It NEVER renders a dead "Connect on Slack" button.
// - missing row → render nothing (workspace predates the feature / provisioning was
//   never dispatched — don't nag every existing workspace home with a fallback card).
// - active w/ invite → the Connect button; active w/o invite → "ready, check email".
// - failed row → booking fallback only.
// max-2-buttons: one real button at most, the booking is a quiet link.
export default async function SlackSupportCard({ workspaceId }: { workspaceId: string }) {
  // Read defensively: a transient DB error on this non-critical card degrades to
  // "no card" instead of crashing the whole workspace home.
  const channel = await getWorkspaceSlackChannel(workspaceId).catch(() => null);
  if (!channel) return null;

  const inviteUrl = safeHttpsUrl(channel.inviteUrl);

  if (channel.status === "active" && inviteUrl) {
    return (
      <section className="mt-8 rounded-lg border border-border bg-surface p-4 text-left">
        <h2 className="text-[13px] font-semibold text-ink">Connect with our team on Slack</h2>
        <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
          We opened a private channel between your team and ours — your direct line to us.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <a
            href={inviteUrl}
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

  if (channel.status === "active") {
    // Channel exists but Slack returned no shareable link (invite delivered by email
    // only). Confirm success instead of falling through to the failed fallback.
    return (
      <section className="mt-8 rounded-lg border border-border bg-surface p-4 text-left">
        <h2 className="text-[13px] font-semibold text-ink">Your Slack channel is ready</h2>
        <p className="mt-1 text-[12.5px] leading-5 text-ink-muted">
          We opened a private channel with our team — check your email for the Slack invite.
        </p>
        <a
          href={BOOK_CALL_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block text-[12px] text-ink-subtle transition-colors hover:text-ink"
        >
          No invite? Book a call
        </a>
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
