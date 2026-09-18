import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { TopNav } from "@/components/marketing/TopNav";
import { DEFAULT_SOCIAL_IMAGE } from "@/lib/social-image";

const title = "Terms of service — opencompany";
const description = "The terms that apply when you access or use opencompany and its services.";
const supportEmail = "support@opencompany.cloud";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/terms" },
  openGraph: {
    type: "website",
    url: "/terms",
    title,
    description,
    images: [DEFAULT_SOCIAL_IMAGE],
  },
  twitter: { card: "summary_large_image", title, description, images: [DEFAULT_SOCIAL_IMAGE] },
};

function TermsSection({ title: sectionTitle, children }: { title: string; children: ReactNode }) {
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

export default function TermsPage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto max-w-4xl px-6 py-16 sm:py-24">
        <p className="font-mono text-[11px] text-violet-700 uppercase tracking-[0.14em]">Legal</p>
        <h1 className="mt-4 text-balance font-medium font-mono text-4xl text-ink tracking-[-0.04em] sm:text-5xl">
          Terms of service
        </h1>
        <p className="mt-4 font-mono text-[12px] text-ink-subtle">Effective September 17, 2026</p>
        <p className="mt-8 max-w-3xl text-base text-ink-muted leading-7">
          These Terms of Service govern your access to and use of opencompany’s websites, hosted
          product, agents, integrations, and related services. By accessing or using the services,
          you agree to these terms. If you use opencompany for an organization, you represent that
          you have authority to accept these terms on its behalf.
        </p>

        <div className="mt-12 space-y-10">
          <TermsSection title="Eligibility and accounts">
            <p>
              You must be legally able to enter into a binding agreement and use the services in
              accordance with applicable law. You must provide accurate account information, protect
              your sign-in credentials, and promptly tell us about suspected unauthorized access.
            </p>
            <p>
              A workspace administrator may manage membership, settings, integrations, billing, and
              access to workspace content. If you join an organization’s workspace, that
              organization may control your account within the workspace and access or manage
              content you create there.
            </p>
          </TermsSection>

          <TermsSection title="The services">
            <p>
              opencompany provides tools for working with AI agents, conversations, tasks,
              workflows, knowledge, code, and connected services. We may add, change, or discontinue
              features as the product develops. We will provide reasonable notice when a change
              materially reduces paid functionality, where practicable.
            </p>
            <p>
              Some features may be labeled beta, preview, experimental, or similar. Those features
              may be incomplete, change without notice, or be withdrawn at any time.
            </p>
          </TermsSection>

          <TermsSection title="AI and automated actions">
            <p>
              The services use generative AI and other automated systems. Outputs may be inaccurate,
              incomplete, outdated, or unsuitable for your circumstances. You are responsible for
              reviewing outputs and deciding whether and how to use them.
            </p>
            <p>
              Agents can take actions in opencompany or connected services when enabled. You are
              responsible for the instructions you provide, the permissions and approval modes you
              configure, and the consequences of approved actions. Do not rely on the services as a
              substitute for professional legal, medical, financial, or other expert advice.
            </p>
          </TermsSection>

          <TermsSection title="Connected services">
            <p>
              You may connect opencompany to third-party services such as Slack, GitHub, email,
              calendars, or model providers. You authorize opencompany to access and act on those
              services within the permissions you grant and the instructions you provide.
            </p>
            <p>
              Your use of a connected service remains subject to that provider’s terms and policies.
              We do not control third-party services and are not responsible for their availability,
              security, functionality, or changes. You must have all rights and permissions needed
              to connect an account and allow the requested processing.
            </p>
          </TermsSection>

          <TermsSection title="Your content">
            <p>
              You retain ownership of prompts, files, messages, code, workspace materials, and other
              content you submit to the services. You grant opencompany a limited, worldwide license
              to host, copy, transmit, process, display, and modify that content only as needed to
              provide, secure, support, and improve the services.
            </p>
            <p>
              You represent that you have the rights needed to submit your content and instruct us
              to process it. You are responsible for your content, including content an agent sends
              to a connected service at your request. Our handling of personal information is
              described in the{" "}
              <Link href="/privacy" className="text-ink underline underline-offset-4">
                privacy policy
              </Link>
              .
            </p>
          </TermsSection>

          <TermsSection title="Acceptable use">
            <p>You may not use the services to:</p>
            <ul className="list-disc space-y-3 pl-5 marker:text-violet-600">
              <li>
                Break the law, violate another person’s rights, or facilitate harmful conduct.
              </li>
              <li>
                Access accounts, systems, conversations, or data without authorization, or bypass
                security, permissions, rate limits, or access controls.
              </li>
              <li>
                Distribute malware, interfere with the services, probe for vulnerabilities without
                authorization, or impose an unreasonable load on our systems.
              </li>
              <li>
                Send spam, deceptive communications, harassment, or content that exploits or harms
                people.
              </li>
              <li>
                Use outputs or automated actions to make unlawful or high-impact decisions about a
                person without appropriate human review.
              </li>
              <li>
                Resell, sublicense, or provide the services to third parties unless we agree in
                writing, or use the services to build a substantially similar competing product in
                violation of applicable law.
              </li>
            </ul>
          </TermsSection>

          <TermsSection title="Paid services">
            <p>
              Prices, included usage, billing intervals, and plan limits are presented before
              purchase. You authorize us and our payment provider to charge the payment method on
              file for recurring fees, usage charges, applicable taxes, and other amounts you
              approve.
            </p>
            <p>
              Subscriptions renew for the stated billing period until canceled. You can cancel
              future renewal through the available billing controls or by contacting support.
              Cancellation takes effect at the end of the current paid period unless stated
              otherwise. Payments are non-refundable except where required by law or expressly
              stated at purchase.
            </p>
          </TermsSection>

          <TermsSection title="Our intellectual property">
            <p>
              We and our licensors retain all rights in the services, branding, designs,
              documentation, and technology other than your content. These terms give you a limited,
              non-exclusive, non-transferable right to use the hosted services while your account is
              active and in compliance with these terms.
            </p>
            <p>
              Parts of opencompany are available under open-source licenses. Those licenses govern
              the applicable source code and take priority over these terms for that code. Feedback
              you provide may be used without restriction or compensation to improve opencompany.
            </p>
          </TermsSection>

          <TermsSection title="Suspension and termination">
            <p>
              You may stop using the services at any time. We may restrict or suspend access when
              reasonably necessary to prevent harm, address a security risk, comply with law,
              respond to nonpayment, or investigate a material violation of these terms. We may
              terminate access for a material or repeated violation.
            </p>
            <p>
              After termination, your right to use the services ends. Provisions that by their
              nature should survive will remain in effect, including provisions concerning
              ownership, fees owed, disclaimers, limitations of liability, and responsibility for
              prior use.
            </p>
          </TermsSection>

          <TermsSection title="Disclaimers">
            <p>
              To the maximum extent permitted by law, the services are provided “as is” and “as
              available.” We disclaim implied warranties of merchantability, fitness for a
              particular purpose, title, and non-infringement. We do not warrant that the services
              or AI outputs will be uninterrupted, secure, error-free, accurate, or suitable for a
              particular use.
            </p>
            <p>
              Nothing in these terms excludes warranties or rights that cannot legally be excluded.
            </p>
          </TermsSection>

          <TermsSection title="Limitation of liability">
            <p>
              To the maximum extent permitted by law, opencompany and its affiliates, suppliers, and
              licensors will not be liable for indirect, incidental, special, consequential,
              exemplary, or punitive damages, or for loss of profits, revenue, data, goodwill, or
              business opportunities arising from or related to the services.
            </p>
            <p>
              To the maximum extent permitted by law, our total liability arising from or related to
              the services will not exceed the amount you paid to opencompany for the services
              during the twelve months before the event giving rise to the claim. These limitations
              do not apply where liability cannot legally be limited.
            </p>
          </TermsSection>

          <TermsSection title="Changes to these terms">
            <p>
              We may update these terms to reflect changes to the services, law, security practices,
              or our business. We will update the effective date above and provide additional notice
              when required. If you continue using the services after revised terms take effect, you
              accept the revised terms.
            </p>
          </TermsSection>

          <TermsSection title="Contact us">
            <p>
              Questions about these terms can be sent to{" "}
              <a href={"mailto:" + supportEmail} className="text-ink underline underline-offset-4">
                {supportEmail}
              </a>
              . You can also visit our{" "}
              <Link href="/support" className="text-ink underline underline-offset-4">
                support page
              </Link>
              .
            </p>
          </TermsSection>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
