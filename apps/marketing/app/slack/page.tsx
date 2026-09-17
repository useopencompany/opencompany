import { Check, SlackIcon } from "@opencompany/ui/icons";
import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { TopNav } from "@/components/marketing/TopNav";
import { DEFAULT_SOCIAL_IMAGE } from "@/lib/social-image";

const title = "Slack for opencompany — search, understand, and act";
const description =
  "Connect your Slack account to opencompany so agents can search conversations, read context, and take permission-gated actions as you.";
const connectUrl = "https://my.opencompany.chat/plugins/slack";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/slack" },
  openGraph: {
    type: "website",
    url: "/slack",
    title,
    description,
    images: [DEFAULT_SOCIAL_IMAGE],
  },
  twitter: { card: "summary_large_image", title, description, images: [DEFAULT_SOCIAL_IMAGE] },
};

const capabilities = [
  {
    title: "Catch up quickly",
    body: "Ask what changed in a project, which direct messages need a reply, or where your team made a decision. Results link back to the original Slack conversations.",
  },
  {
    title: "Read the full context",
    body: "Let an agent read the relevant channels, threads, canvases, files, reactions, and profiles instead of working from a single copied message.",
  },
  {
    title: "Turn answers into action",
    body: "Draft or send a message, schedule a follow-up, upload a file, add a reaction, start a conversation, or update a canvas after you approve the change.",
  },
];

const permissions = [
  {
    label: "Search public Slack",
    mode: "On by default",
    body: "Agents can search public conversations when your request calls for Slack context.",
  },
  {
    label: "Read private Slack",
    mode: "Ask by default",
    body: "Private channels, direct messages, threads, files, and profiles require your approval.",
  },
  {
    label: "Change Slack",
    mode: "Ask by default",
    body: "Sending messages, scheduling posts, uploading files, adding reactions, and editing canvases require your approval.",
  },
];

export default function SlackPage() {
  return (
    <>
      <TopNav />
      <main>
        <section className="border-border border-b">
          <div className="mx-auto grid max-w-6xl gap-12 px-6 py-16 sm:py-24 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-20">
            <div>
              <div className="mb-6 flex items-center gap-2 font-mono text-[12px] text-violet-700 uppercase tracking-[0.14em]">
                <SlackIcon aria-hidden="true" className="size-4" />
                Slack for opencompany
              </div>
              <h1 className="max-w-3xl text-balance font-medium font-mono text-4xl text-ink leading-[1.08] tracking-[-0.05em] sm:text-6xl">
                Give your agents the Slack context they need.
              </h1>
              <p className="mt-6 max-w-2xl text-pretty text-base text-ink-muted leading-7 sm:text-lg sm:leading-8">
                Connect your own Slack account to opencompany. Agents can find the conversations
                behind a decision, summarize what you missed, and help you act without gaining
                access to anything you cannot already see.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-4">
                <a
                  href={connectUrl}
                  className="inline-flex items-center gap-2 bg-[#4A154B] px-4 py-2.5 font-medium text-[14px] text-white transition-opacity hover:opacity-90"
                >
                  <SlackIcon aria-hidden="true" className="size-4" />
                  Add to Slack
                </a>
                <a
                  href="#how-it-works"
                  className="font-medium text-[14px] text-ink underline decoration-border underline-offset-4 transition-colors hover:decoration-ink"
                >
                  See how it works
                </a>
              </div>
              <p className="mt-4 max-w-xl text-[12px] text-ink-subtle leading-5">
                You need an opencompany account. If you are signed out, we will ask you to sign in
                or create one before connecting Slack.
              </p>
            </div>

            <div className="border border-border bg-muted/30 p-5 sm:p-7">
              <p className="font-mono text-[11px] text-ink-subtle uppercase tracking-[0.14em]">
                Try asking
              </p>
              <div className="mt-5 space-y-3">
                {[
                  "What DMs did I receive this morning?",
                  "Find the decision we made about pricing and link the thread.",
                  "Summarize today’s customer feedback and draft a reply for #product.",
                ].map((prompt) => (
                  <div
                    key={prompt}
                    className="border border-border bg-background px-4 py-3 text-[14px] text-ink leading-6"
                  >
                    “{prompt}”
                  </div>
                ))}
              </div>
              <div className="mt-6 border-border border-t pt-5">
                <p className="text-[13px] text-ink-muted leading-6">
                  Each teammate connects separately. An agent uses the connected person’s Slack
                  visibility and permissions for every request.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <p className="font-mono text-[11px] text-violet-700 uppercase tracking-[0.14em]">
            What you can do
          </p>
          <h2 className="mt-4 max-w-2xl text-balance font-medium text-3xl text-ink tracking-tight sm:text-4xl">
            Work from the conversation, not a pasted excerpt.
          </h2>
          <div className="mt-10 grid border-border border-t sm:grid-cols-3 sm:divide-x sm:divide-border">
            {capabilities.map((capability) => (
              <article
                key={capability.title}
                className="border-border border-b py-7 sm:px-7 sm:first:pl-0 sm:last:pr-0"
              >
                <h3 className="font-medium text-[16px] text-ink">{capability.title}</h3>
                <p className="mt-3 text-[14px] text-ink-muted leading-6">{capability.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="border-border border-y bg-muted/30">
          <div className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
            <p className="font-mono text-[11px] text-violet-700 uppercase tracking-[0.14em]">
              Permission controls
            </p>
            <h2 className="mt-4 max-w-2xl text-balance font-medium text-3xl text-ink tracking-tight sm:text-4xl">
              Your Slack access stays personal.
            </h2>
            <p className="mt-5 max-w-2xl text-[15px] text-ink-muted leading-7">
              Public search can run when it is useful. Sensitive reads and Slack changes pause for
              your approval by default. You can change these modes from the Slack plugin page in
              opencompany.
            </p>
            <div className="mt-10 grid gap-4 lg:grid-cols-3">
              {permissions.map((permission) => (
                <article key={permission.label} className="border border-border bg-background p-5">
                  <p className="font-medium text-[15px] text-ink">{permission.label}</p>
                  <p className="mt-2 w-fit bg-violet-50 px-2 py-1 font-mono text-[11px] text-violet-700">
                    {permission.mode}
                  </p>
                  <p className="mt-4 text-[13px] text-ink-muted leading-6">{permission.body}</p>
                </article>
              ))}
            </div>
            <div className="mt-8 grid gap-3 text-[13px] text-ink-muted leading-6 sm:grid-cols-2">
              {[
                "Slack applies the connected user’s existing channel and workspace permissions.",
                "OAuth credentials stay encrypted and server-side and are used with Slack’s hosted MCP server.",
                "Connecting one teammate does not expose another teammate’s private conversations.",
                "Disconnecting Slack removes the stored integration and its credential from opencompany.",
              ].map((item) => (
                <p key={item} className="flex gap-2.5">
                  <Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-violet-700" />
                  <span>{item}</span>
                </p>
              ))}
            </div>
          </div>
        </section>

        <section id="how-it-works" className="mx-auto max-w-6xl scroll-mt-16 px-6 py-16 sm:py-24">
          <p className="font-mono text-[11px] text-violet-700 uppercase tracking-[0.14em]">
            Get started
          </p>
          <h2 className="mt-4 text-balance font-medium text-3xl text-ink tracking-tight sm:text-4xl">
            Connect in three steps.
          </h2>
          <ol className="mt-10 grid gap-8 sm:grid-cols-3">
            {[
              [
                "1",
                "Open Slack in opencompany",
                "Sign in, open Plugins → Slack, and ask a workspace admin to enable the plugin if needed.",
              ],
              [
                "2",
                "Connect your account",
                "Approve Slack’s OAuth screen. Every teammate who wants Slack tools connects their own account.",
              ],
              [
                "3",
                "Ask opencompany",
                "Mention Slack in a chat, task, or workflow. The agent will ask before private reads or write actions by default.",
              ],
            ].map(([number, heading, body]) => (
              <li key={number} className="border-border border-t pt-5">
                <span className="font-mono text-[12px] text-violet-700">{number}</span>
                <h3 className="mt-3 font-medium text-[16px] text-ink">{heading}</h3>
                <p className="mt-2 text-[14px] text-ink-muted leading-6">{body}</p>
              </li>
            ))}
          </ol>
          <div className="mt-12 flex flex-wrap items-center gap-4 border border-border bg-muted/30 p-6 sm:p-8">
            <div className="mr-auto max-w-2xl">
              <h2 className="font-medium text-xl text-ink">Ready to connect Slack?</h2>
              <p className="mt-2 text-[14px] text-ink-muted leading-6">
                Open the Slack plugin in opencompany to install it or connect your account.
              </p>
            </div>
            <a
              href={connectUrl}
              className="inline-flex items-center gap-2 bg-[#4A154B] px-4 py-2.5 font-medium text-[14px] text-white transition-opacity hover:opacity-90"
            >
              <SlackIcon aria-hidden="true" className="size-4" />
              Add to Slack
            </a>
          </div>
          <p className="mt-8 text-[12px] text-ink-subtle leading-5">
            opencompany uses generative AI. Responses, summaries, drafts, and other outputs may be
            inaccurate or incomplete. Review important information and approve actions carefully.
            Read our{" "}
            <Link href="/privacy" className="underline underline-offset-3">
              privacy policy
            </Link>{" "}
            or visit{" "}
            <Link href="/support" className="underline underline-offset-3">
              support
            </Link>
            .
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
