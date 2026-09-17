import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { TopNav } from "@/components/marketing/TopNav";
import { DEFAULT_SOCIAL_IMAGE } from "@/lib/social-image";

const title = "Support — opencompany";
const description =
  "Get help with opencompany and its Slack integration without creating another account.";
const supportEmail = "support@opencompany.cloud";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/support" },
  openGraph: {
    type: "website",
    url: "/support",
    title,
    description,
    images: [DEFAULT_SOCIAL_IMAGE],
  },
  twitter: { card: "summary_large_image", title, description, images: [DEFAULT_SOCIAL_IMAGE] },
};

const slackChecks = [
  "Confirm an opencompany workspace admin has enabled the Slack plugin.",
  "Reconnect your personal Slack account if your workspace, scopes, or administrator approval changed.",
  "Check the Slack plugin permission controls. Private reads and changes to Slack ask for approval by default.",
  "Make sure your Slack account can access the channel, thread, file, or canvas you asked the agent to use.",
];

export default function SupportPage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto max-w-4xl px-6 py-16 sm:py-24">
        <p className="font-mono text-[11px] text-violet-700 uppercase tracking-[0.14em]">Support</p>
        <h1 className="mt-4 text-balance font-medium font-mono text-4xl text-ink tracking-[-0.04em] sm:text-5xl">
          How can we help?
        </h1>
        <p className="mt-6 max-w-2xl text-base text-ink-muted leading-7">
          Email us for help with opencompany, installation, billing, or the Slack integration. You
          do not need to create an additional account or use another service to contact support.
        </p>

        <section
          className="mt-10 border border-border bg-muted/30 p-6 sm:p-8"
          aria-labelledby="contact-support"
        >
          <h2 id="contact-support" className="font-medium text-xl text-ink">
            Contact support
          </h2>
          <a
            href={`mailto:${supportEmail}?subject=opencompany%20support%20request`}
            className="mt-4 inline-block font-medium text-violet-700 underline underline-offset-4"
          >
            {supportEmail}
          </a>
          <p className="mt-3 text-[14px] text-ink-muted leading-6">
            We respond within two business days. Include the affected workspace, what you expected
            to happen, what happened instead, and any useful error message. Do not send passwords,
            OAuth tokens, API keys, or other secrets.
          </p>
        </section>

        <div className="mt-14 grid gap-12 md:grid-cols-2 md:gap-16">
          <section aria-labelledby="slack-help">
            <h2 id="slack-help" className="font-medium text-2xl text-ink tracking-tight">
              Slack connection help
            </h2>
            <ol className="mt-5 space-y-4 text-[14px] text-ink-muted leading-6">
              {slackChecks.map((check, index) => (
                <li key={check} className="flex gap-3">
                  <span className="font-mono text-[12px] text-violet-700">{index + 1}</span>
                  <span>{check}</span>
                </li>
              ))}
            </ol>
            <Link
              href="/slack"
              className="mt-6 inline-block text-[14px] text-ink underline underline-offset-4"
            >
              Read the Slack installation guide
            </Link>
          </section>

          <section aria-labelledby="privacy-help">
            <h2 id="privacy-help" className="font-medium text-2xl text-ink tracking-tight">
              Privacy and data requests
            </h2>
            <p className="mt-5 text-[14px] text-ink-muted leading-6">
              Use the same email address to request access to, correction of, export of, or deletion
              of your personal data. We may need to verify your identity and workspace relationship
              before completing the request.
            </p>
            <Link
              href="/privacy"
              className="mt-6 inline-block text-[14px] text-ink underline underline-offset-4"
            >
              Read the privacy policy
            </Link>
          </section>
        </div>

        <section className="mt-14 border-border border-t pt-8" aria-labelledby="security-reports">
          <h2 id="security-reports" className="font-medium text-xl text-ink">
            Security reports
          </h2>
          <p className="mt-3 max-w-2xl text-[14px] text-ink-muted leading-6">
            Report suspected vulnerabilities privately. Email {supportEmail} with “Security” in the
            subject, or use GitHub’s private vulnerability reporting for the open-source repository.
            Please do not disclose an unresolved issue publicly.
          </p>
          <a
            href="https://github.com/useopencompany/opencompany/security/advisories/new"
            className="mt-4 inline-block text-[14px] text-ink underline underline-offset-4"
          >
            Open a private security report
          </a>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
