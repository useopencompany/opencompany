import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { TopNav } from "@/components/marketing/TopNav";
import { DEFAULT_SOCIAL_IMAGE } from "@/lib/social-image";

const title = "Privacy policy — opencompany";
const description =
  "How opencompany collects, uses, shares, retains, and protects personal data and connected-service data.";
const supportEmail = "support@opencompany.cloud";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/privacy" },
  openGraph: {
    type: "website",
    url: "/privacy",
    title,
    description,
    images: [DEFAULT_SOCIAL_IMAGE],
  },
  twitter: { card: "summary_large_image", title, description, images: [DEFAULT_SOCIAL_IMAGE] },
};

function PolicySection({ title: sectionTitle, children }: { title: string; children: ReactNode }) {
  return (
    <section
      className="border-border border-t pt-8"
      aria-labelledby={sectionTitle.toLowerCase().replaceAll(" ", "-")}
    >
      <h2
        id={sectionTitle.toLowerCase().replaceAll(" ", "-")}
        className="font-medium text-2xl text-ink tracking-tight"
      >
        {sectionTitle}
      </h2>
      <div className="mt-4 space-y-4 text-[15px] text-ink-muted leading-7">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto max-w-4xl px-6 py-16 sm:py-24">
        <p className="font-mono text-[11px] text-violet-700 uppercase tracking-[0.14em]">Legal</p>
        <h1 className="mt-4 text-balance font-medium font-mono text-4xl text-ink tracking-[-0.04em] sm:text-5xl">
          Privacy policy
        </h1>
        <p className="mt-4 font-mono text-[12px] text-ink-subtle">
          Last updated September 17, 2026
        </p>
        <p className="mt-8 max-w-3xl text-base text-ink-muted leading-7">
          This policy explains how opencompany collects, uses, shares, retains, and protects
          personal information when you use our websites, hosted product, and integrations,
          including our Slack apps. It also explains the choices available to you.
        </p>

        <div className="mt-12 space-y-10">
          <PolicySection title="Information we collect">
            <p>We collect the following categories of information:</p>
            <ul className="list-disc space-y-3 pl-5 marker:text-violet-600">
              <li>
                <strong className="font-medium text-ink">Account and workspace information:</strong>{" "}
                names, email addresses, authentication identifiers, workspace membership, roles, and
                settings.
              </li>
              <li>
                <strong className="font-medium text-ink">Content you provide:</strong> prompts,
                conversations, files, code, tasks, workflows, wiki content, approvals, agent
                outputs, and support communications.
              </li>
              <li>
                <strong className="font-medium text-ink">Connected-service information:</strong>{" "}
                OAuth credentials, account and workspace identifiers, permission grants, and data
                retrieved or changed when you ask opencompany to use a connected service.
              </li>
              <li>
                <strong className="font-medium text-ink">Usage and technical information:</strong>{" "}
                feature activity, browser and device information, IP address, diagnostics, error
                reports, security events, and service logs.
              </li>
              <li>
                <strong className="font-medium text-ink">Billing information:</strong> subscription,
                invoice, and transaction records. Payment-card details are handled by our payment
                provider rather than stored directly by opencompany.
              </li>
            </ul>
          </PolicySection>

          <PolicySection title="Slack data">
            <p>
              When you connect your personal Slack account, we receive your Slack user and workspace
              identifiers, profile details made available during authorization, the scopes you
              granted, and an OAuth credential. When an agent uses Slack for your request, Slack may
              return messages, channels, threads, canvases, files, reactions, profiles, membership
              information, and related metadata that your Slack account is allowed to access.
            </p>
            <p>
              Slack applies your existing visibility and permissions. Connecting one person’s
              account does not grant another person access to their private conversations. The
              personal integration uses Slack’s hosted MCP server, and the OAuth credential remains
              encrypted and server-side.
            </p>
            <p>
              The separately administered workspace bot receives direct messages sent to the bot,
              replies in threads where it participates, delivery metadata, user and workspace
              identifiers, and the public-channel information needed to post and reconcile messages.
              It does not join channels on its own.
            </p>
            <p>
              We do not use Slack data to train AI models. We do not continuously copy Slack into a
              separate message archive. Slack content selected for an agent request may be saved in
              the resulting opencompany conversation, task, workflow output, or artifact so that you
              can review and continue the work.
            </p>
          </PolicySection>

          <PolicySection title="How we use information">
            <ul className="list-disc space-y-3 pl-5 marker:text-violet-600">
              <li>Provide, operate, personalize, and improve opencompany.</li>
              <li>Authenticate users and connect requested third-party services.</li>
              <li>
                Run agent requests, tasks, workflows, approvals, and connected-service actions.
              </li>
              <li>
                Maintain service reliability, prevent abuse, investigate errors, and protect
                security.
              </li>
              <li>
                Process subscriptions and communicate about service, support, and policy updates.
              </li>
              <li>Comply with legal obligations and enforce our agreements.</li>
            </ul>
          </PolicySection>

          <PolicySection title="AI processing">
            <p>
              To run an agent request, opencompany sends the prompt and the selected context needed
              for that request to the model or agent provider configured for the session. That
              context may include content retrieved from Slack or another connected service. The
              provider processes it to generate the requested result or tool decision.
            </p>
            <p>
              AI outputs can be inaccurate or incomplete. opencompany provides permission controls
              for connected tools, and sensitive reads or write actions may require approval based
              on your settings.
            </p>
          </PolicySection>

          <PolicySection title="How we share information">
            <p>We share information only as needed for the following purposes:</p>
            <ul className="list-disc space-y-3 pl-5 marker:text-violet-600">
              <li>
                With infrastructure, authentication, model, payment, analytics, monitoring, and
                support providers that help us operate opencompany.
              </li>
              <li>
                With connected services when you ask opencompany to retrieve data or take an action.
              </li>
              <li>
                With other members of your opencompany workspace according to your workspace and
                content settings.
              </li>
              <li>
                When required by law, to protect rights and safety, or in connection with a merger,
                financing, acquisition, or sale of assets.
              </li>
            </ul>
            <p>We do not sell personal information.</p>
          </PolicySection>

          <PolicySection title="How long we keep information">
            <ul className="list-disc space-y-3 pl-5 marker:text-violet-600">
              <li>
                Account, workspace, and saved product content is kept while the relevant account or
                workspace is active, unless you delete it sooner or request deletion.
              </li>
              <li>
                A Slack or other connected-service OAuth credential is kept for the life of that
                connection. Disconnecting the personal integration removes its stored integration
                record and credential from the active service.
              </li>
              <li>
                Connected-service data saved in a conversation, task, workflow output, wiki page, or
                artifact is kept for the life of that content or workspace.
              </li>
              <li>
                Temporary request data and caches are kept only as long as needed to complete and
                reliably deliver the request.
              </li>
              <li>
                Billing, security, fraud-prevention, support, and legal records are kept as long as
                reasonably necessary for those purposes or as required by law. Deleted data may
                remain for a limited period in restricted backups until normal rotation completes.
              </li>
            </ul>
          </PolicySection>

          <PolicySection title="Your choices and rights">
            <p>
              You can manage connected services and their permission modes from opencompany. You can
              also revoke opencompany from Slack’s app management settings. Workspace admins control
              workspace membership and workspace-level integrations.
            </p>
            <p>
              You may request access to, correction of, export of, or deletion of your personal
              information by emailing{" "}
              <a href={`mailto:${supportEmail}`} className="text-ink underline underline-offset-4">
                {supportEmail}
              </a>
              . You may also object to or ask us to restrict certain processing where applicable. We
              may need to verify your identity and authority over the relevant account or workspace
              before completing a request.
            </p>
          </PolicySection>

          <PolicySection title="Security and international processing">
            <p>
              We use administrative, technical, and organizational measures designed to protect
              information, including access controls and encryption for stored integration
              credentials. No method of storage or transmission is completely secure.
            </p>
            <p>
              opencompany and its service providers may process information in countries other than
              the one where you live. Where required, we use appropriate safeguards for these
              transfers.
            </p>
          </PolicySection>

          <PolicySection title="Children">
            <p>
              opencompany is a business service and is not directed to children under 13. We do not
              knowingly collect personal information from children under 13.
            </p>
          </PolicySection>

          <PolicySection title="Changes to this policy">
            <p>
              We may update this policy as the product or legal requirements change. We will update
              the date above and provide additional notice when a change materially affects your
              rights or how we use personal information.
            </p>
          </PolicySection>

          <PolicySection title="Contact us">
            <p>
              Contact us at{" "}
              <a href={`mailto:${supportEmail}`} className="text-ink underline underline-offset-4">
                {supportEmail}
              </a>{" "}
              with privacy questions or data requests. You can also visit our{" "}
              <Link href="/support" className="text-ink underline underline-offset-4">
                support page
              </Link>
              .
            </p>
          </PolicySection>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
