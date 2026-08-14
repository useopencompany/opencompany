import type { Metadata } from "next";
import { BlogShell } from "@/components/marketing/BlogShell";
import { DEFAULT_SOCIAL_IMAGE } from "@/lib/social-image";

const title = "Sponsor opencompany — the channel for the startup scene";
const description =
  "opencompany is the YouTube show founders actually watch. Every viewer is building or working at a startup. Put your product in front of them.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/media",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/media",
    siteName: "opencompany",
    title,
    description,
    images: [DEFAULT_SOCIAL_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [DEFAULT_SOCIAL_IMAGE],
  },
};

// Sponsorship inquiry inbox — confirm this address before shipping.
const SPONSOR_EMAIL = "sponsors@opencompany.cloud";
const CHANNEL_URL = "https://www.youtube.com/@opencompanyai";

// Most recent upload — refresh the id/title when a new flagship episode ships.
const LATEST_VIDEO = {
  id: "rwagAH96bQ8",
  title: "How to build a Lean Startup with Steve Blank",
};

const STATS = [
  { value: "40K", label: "views / month", sub: "on the main channel" },
  { value: "100K", label: "short-form impressions", sub: "per episode, on top" },
  { value: "3.4K", label: "watch hours / month", sub: "long-form attention" },
  { value: "3.2K", label: "subscribers", sub: "3 months in, growing fast" },
];

const GUESTS = [
  {
    name: "Steve Blank",
    role: "Father of the Lean Startup movement",
    href: "https://steveblank.com/",
  },
  {
    name: "Sankaet Pathak",
    role: "Founder & CEO, Foundation (humanoid robotics)",
    href: "https://foundation.bot/",
  },
  {
    name: "HumanX",
    role: "The world's premier AI conference",
    href: "https://www.humanx.co/",
  },
];

const AUDIENCE = [
  {
    value: "75%",
    label: "are over 25",
    sub: "Decision-makers with budget — not students.",
  },
  {
    value: "100%",
    label: "work in startups",
    sub: "Founders and early operators building right now.",
  },
  {
    value: "Same feed as",
    label: "YC · 20VC · a16z · Daniel Dalen",
    sub: "They watch us next to the people they already trust.",
  },
];

export default function MediaPage() {
  return (
    <BlogShell>
      {/* Hero */}
      <section className="mx-auto max-w-3xl px-6 pt-20 pb-10 sm:pt-28">
        <p className="mb-4 font-medium font-mono text-[11px] text-violet-600 uppercase tracking-[0.16em]">
          #media kit
        </p>
        <h1 className="max-w-2xl text-balance font-medium text-4xl text-ink leading-[1.1] tracking-tight sm:text-5xl">
          Put your product in front of founders who are actually building.
        </h1>
        <p className="mt-6 max-w-2xl text-pretty text-[15px] text-ink-muted leading-7">
          opencompany is the YouTube channel for the startup scene. We&apos;re not chasing millions
          of passive views — every viewer is a founder or works at a startup. It&apos;s the exact
          room your product is trying to get into.
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-3">
          <a
            href={`mailto:${SPONSOR_EMAIL}?subject=Sponsorship%20inquiry`}
            className="inline-flex items-center rounded-none bg-black px-4 py-2.5 font-medium font-mono text-[13px] text-white tracking-tight transition hover:bg-black/85"
          >
            Talk to us about sponsoring →
          </a>
          <a
            href={CHANNEL_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center rounded-none px-2 py-2.5 font-medium font-mono text-[13px] text-ink-subtle tracking-tight transition hover:text-ink"
          >
            Watch the channel
          </a>
        </div>
      </section>

      {/* Latest episode embed */}
      <section className="mx-auto max-w-3xl px-6 pb-16">
        <h2 className="font-mono text-[11px] text-ink-subtle uppercase tracking-[0.12em]">
          Latest episode
        </h2>
        <div className="mt-5 aspect-video w-full overflow-hidden border border-border">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${LATEST_VIDEO.id}`}
            title={LATEST_VIDEO.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            className="h-full w-full"
          />
        </div>
        <p className="mt-3 text-[13px] text-ink-subtle leading-6">{LATEST_VIDEO.title}</p>
      </section>

      {/* Reach */}
      <section className="mx-auto max-w-3xl px-6 pb-16">
        <h2 className="font-mono text-[11px] text-ink-subtle uppercase tracking-[0.12em]">
          The reach
        </h2>
        <div className="mt-5 grid grid-cols-2 divide-x divide-y divide-border border-border border-t border-l">
          {STATS.map((stat) => (
            <div key={stat.label} className="px-5 py-7 sm:px-6 sm:py-8">
              <p className="font-medium font-mono text-3xl text-ink tracking-tight sm:text-4xl">
                {stat.value}
              </p>
              <p className="mt-2 font-mono text-[13px] text-ink">{stat.label}</p>
              <p className="mt-1 text-[13px] text-ink-muted leading-5">{stat.sub}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[13px] text-ink-subtle leading-6">
          A short episode drops on the channel and clips it out to 100K+ short-form impressions — so
          a single sponsor read compounds across long-form and shorts.
        </p>
      </section>

      {/* Audience quality — the real pitch */}
      <section className="mx-auto max-w-3xl px-6 pb-16">
        <h2 className="font-mono text-[11px] text-ink-subtle uppercase tracking-[0.12em]">
          Who&apos;s watching
        </h2>
        <p className="mt-5 max-w-2xl text-[15px] text-ink-muted leading-7">
          Forty thousand views a month isn&apos;t &quot;millions&quot; — and that&apos;s the point.
          There&apos;s no filler audience here. The people watching are the people you want to
          reach: founders and operators making buying decisions for the tools their companies run
          on.
        </p>
        <div className="mt-7 grid grid-cols-1 divide-y divide-border border-border border-t sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {AUDIENCE.map((item) => (
            <div key={item.label} className="py-6 sm:px-5 sm:py-7 sm:first:pl-0">
              <p className="font-medium font-mono text-[15px] text-violet-700">{item.value}</p>
              <p className="mt-1 font-medium font-mono text-[15px] text-ink">{item.label}</p>
              <p className="mt-2 text-[13px] text-ink-muted leading-5">{item.sub}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Featured guests */}
      <section className="mx-auto max-w-3xl px-6 pb-16">
        <h2 className="font-mono text-[11px] text-ink-subtle uppercase tracking-[0.12em]">
          Who&apos;s been on
        </h2>
        <p className="mt-5 max-w-2xl text-[15px] text-ink-muted leading-7">
          The room is small, but the guests aren&apos;t. A sponsor read sits alongside conversations
          with the people shaping how companies get built.
        </p>
        <div className="mt-7 grid grid-cols-1 divide-y divide-border border-border border-t sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {GUESTS.map((guest) => (
            <a
              key={guest.name}
              href={guest.href}
              target="_blank"
              rel="noreferrer"
              className="group block py-6 sm:px-5 sm:py-7 sm:first:pl-0"
            >
              <p className="font-medium font-mono text-[15px] text-ink transition-colors group-hover:text-violet-700">
                {guest.name}
                <span aria-hidden="true" className="ml-1.5 text-violet-600">
                  ↗
                </span>
              </p>
              <p className="mt-2 text-[13px] text-ink-muted leading-5">{guest.role}</p>
            </a>
          ))}
        </div>
      </section>

      {/* Momentum */}
      <section className="mx-auto max-w-3xl px-6 pb-16">
        <h2 className="font-mono text-[11px] text-ink-subtle uppercase tracking-[0.12em]">
          The momentum
        </h2>
        <p className="mt-5 max-w-2xl text-[15px] text-ink-muted leading-7">
          We launched three months ago and just wrapped our San Francisco Founder Series. Growth is
          steep and early — which means sponsors coming in now lock in below where these numbers are
          headed, and grow alongside a channel that&apos;s clearly on the way up.
        </p>
      </section>

      {/* Formats */}
      <section className="mx-auto max-w-3xl px-6 pb-16">
        <h2 className="font-mono text-[11px] text-ink-subtle uppercase tracking-[0.12em]">
          Ways to work together
        </h2>
        <ul className="mt-5 space-y-3">
          {[
            "Integrated segment — a genuine, hand-crafted read woven into an episode.",
            "Dedicated episode — a full video built around your product and the founders using it.",
            "Short-form placement — your product featured across the clips that drive 100K+ impressions per episode.",
          ].map((line) => (
            <li key={line} className="flex gap-3 text-[15px] text-ink-muted leading-7">
              <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 bg-violet-600" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-3xl px-6 pb-24">
        <div className="border border-border p-8 sm:p-10">
          <h2 className="font-medium text-2xl text-ink tracking-tight sm:text-3xl">
            Let&apos;s get your product in front of them.
          </h2>
          <p className="mt-3 max-w-xl text-[15px] text-ink-muted leading-7">
            Tell us a little about what you&apos;re building and we&apos;ll send pricing and
            availability. Spots are limited — we keep sponsor load low so every read actually lands.
          </p>
          <a
            href={`mailto:${SPONSOR_EMAIL}?subject=Sponsorship%20inquiry`}
            className="mt-6 inline-flex items-center rounded-none bg-black px-4 py-2.5 font-medium font-mono text-[13px] text-white tracking-tight transition hover:bg-black/85"
          >
            {SPONSOR_EMAIL} →
          </a>
        </div>
      </section>
    </BlogShell>
  );
}
