import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  CircleDashed,
  ExternalLink,
  History,
  Plus,
  RefreshCw,
  ShieldAlert,
  Tag,
  Trash2,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import {
  type Changelog,
  type ChangeSection,
  type InlineToken,
  isVideoSrc,
  type Release,
  renderInline,
} from "@/lib/changelog";

type CategoryStyle = {
  icon: LucideIcon;
  dot: string;
  text: string;
  pill: string;
  border: string;
};

const CATEGORY_STYLES: Record<string, CategoryStyle> = {
  Added: {
    icon: Plus,
    dot: "bg-success",
    text: "text-success",
    pill: "bg-success-bg text-success",
    border: "border-success-border",
  },
  Changed: {
    icon: RefreshCw,
    dot: "bg-info",
    text: "text-info",
    pill: "bg-info-bg text-info",
    border: "border-info-border",
  },
  Deprecated: {
    icon: CircleDashed,
    dot: "bg-warning",
    text: "text-warning",
    pill: "bg-warning-bg text-warning",
    border: "border-warning-border",
  },
  Removed: {
    icon: Trash2,
    dot: "bg-danger",
    text: "text-danger",
    pill: "bg-danger-bg text-danger",
    border: "border-danger-border",
  },
  Fixed: {
    icon: Wrench,
    dot: "bg-brand",
    text: "text-brand",
    pill: "bg-brand-bg text-brand",
    border: "border-brand-border",
  },
  Security: {
    icon: ShieldAlert,
    dot: "bg-danger",
    text: "text-danger",
    pill: "bg-danger-bg text-danger",
    border: "border-danger-border",
  },
};

const FALLBACK_STYLE: CategoryStyle = {
  icon: AlertTriangle,
  dot: "bg-ink-muted",
  text: "text-ink-muted",
  pill: "bg-surface-subtle text-ink-muted",
  border: "border-border",
};

function getCategoryStyle(category: string): CategoryStyle {
  return CATEGORY_STYLES[category] ?? FALLBACK_STYLE;
}

function InlineMarkdown({ text }: { text: string }) {
  const tokens = renderInline(text);
  return (
    <>
      {tokens.map((token, i) => (
        <InlineTokenView key={i} token={token} />
      ))}
    </>
  );
}

// Renders `![alt](src)` media. Videos (.mp4/.webm/.mov) play GIF-style:
// muted, looping, inline. Uses block-level <span> wrappers so the embed
// stays valid inside the <p>/<span> containers InlineMarkdown renders into.
function MediaEmbed({ alt, src }: { alt: string; src: string }) {
  return (
    <span className="my-2 block max-w-[560px] overflow-hidden rounded-lg border border-border bg-surface-subtle shadow-[0_1px_0_rgba(0,0,0,0.02)]">
      {isVideoSrc(src) ? (
        <video
          src={src}
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
          aria-label={alt || "Screen recording"}
          className="block w-full"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- remote changelog media, dimensions unknown
        <img src={src} alt={alt} loading="lazy" className="block w-full" />
      )}
    </span>
  );
}

function InlineTokenView({ token }: { token: InlineToken }) {
  switch (token.kind) {
    case "image":
      return <MediaEmbed alt={token.alt} src={token.src} />;
    case "code":
      return (
        <code className="rounded bg-surface-subtle px-1 py-0.5 font-mono text-[12px] text-ink">
          {token.text}
        </code>
      );
    case "strong":
      return <strong className="font-semibold text-ink">{token.text}</strong>;
    case "link":
      return (
        <a
          href={token.href}
          className="text-ink underline decoration-border-strong underline-offset-2 transition-colors hover:decoration-ink/60"
        >
          {token.text}
        </a>
      );
    default:
      return <>{token.text}</>;
  }
}

function ReleasePill({ release }: { release: Release }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-[12px] font-medium tracking-[-0.005em] text-ink shadow-[0_1px_0_rgba(0,0,0,0.02)]">
      <Tag size={11} strokeWidth={1.9} className="text-ink-muted" />
      <span className="font-mono text-[12px]">{release.version}</span>
    </span>
  );
}

function SectionBlock({ section }: { section: ChangeSection }) {
  const style = getCategoryStyle(section.category);
  const Icon = style.icon;
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span
          className={`inline-flex h-5 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium tracking-[-0.005em] ${style.pill}`}
        >
          <Icon size={11} strokeWidth={2} />
          {section.category}
        </span>
        <span className="text-[11px] text-ink-subtle">
          {section.items.length} {section.items.length === 1 ? "entry" : "entries"}
        </span>
      </div>
      <ul className="space-y-1.5">
        {section.items.map((item, i) => (
          <li
            key={i}
            className="flex gap-2 text-[13.5px] leading-6 tracking-[-0.005em] text-ink/90"
          >
            <span
              aria-hidden
              className={`mt-[9px] inline-block h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`}
            />
            <span className="min-w-0">
              <InlineMarkdown text={item} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReleaseCard({ release }: { release: Release }) {
  const id = `release-${release.version.toLowerCase()}`;
  return (
    <section id={id} className="scroll-mt-20">
      <div className="flex flex-wrap items-center gap-2.5">
        <ReleasePill release={release} />
        {release.date && <span className="text-[12.5px] text-ink-muted">{release.date}</span>}
        {release.yanked && (
          <span className="inline-flex items-center gap-1 rounded-md bg-danger-bg px-1.5 py-0.5 text-[11px] font-medium text-danger">
            <AlertTriangle size={11} strokeWidth={2} />
            YANKED
          </span>
        )}
        {release.link && (
          <a
            href={release.link}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-ink-muted transition-colors hover:bg-surface-subtle hover:text-ink"
          >
            Compare
            <ArrowUpRight size={12} strokeWidth={1.9} />
          </a>
        )}
      </div>

      {release.notes.length > 0 && (
        <div className="mt-3 space-y-2 text-[13.5px] leading-6 tracking-[-0.005em] text-ink/85">
          {release.notes.map((note, i) => (
            <p key={i}>
              <InlineMarkdown text={note} />
            </p>
          ))}
        </div>
      )}

      <div className="mt-4 rounded-lg border border-border bg-surface p-4 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
        {release.sections.length === 0 ? (
          <p className="text-[13px] text-ink-subtle">No changes recorded.</p>
        ) : (
          <div className="space-y-5">
            {release.sections.map((section, i) => (
              <SectionBlock key={i} section={section} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function TopBar() {
  return (
    <div className="desktop-standalone-title-bar sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-border-subtle bg-canvas/85 px-5 backdrop-blur-md">
      <Link
        href="/"
        prefetch={false}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-ink-muted transition-colors hover:bg-surface-subtle hover:text-ink"
      >
        <ArrowLeft size={13} strokeWidth={1.75} />
        opencompany
      </Link>
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-muted">
        <span className="truncate font-medium text-ink">CHANGELOG.md</span>
      </div>
      <a
        href="https://keepachangelog.com/en/1.1.0/"
        target="_blank"
        rel="noreferrer"
        className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-muted transition-colors hover:bg-surface-subtle hover:text-ink"
      >
        Keep a Changelog 1.1.0
        <ExternalLink size={11} strokeWidth={1.9} />
      </a>
    </div>
  );
}

function OutlinePanel({ releases }: { releases: Release[] }) {
  return (
    <aside className="hidden w-[232px] shrink-0 overflow-y-auto border-l border-border bg-canvas px-4 py-4 xl:block">
      <div className="sticky top-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
            Releases
          </span>
          <History size={13} strokeWidth={1.75} className="text-ink-subtle" />
        </div>
        <nav className="space-y-px">
          {releases.map((release, index) => (
            <a
              key={release.version}
              href={`#release-${release.version.toLowerCase()}`}
              className={`flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[12.5px] transition-colors duration-150 ${
                index === 0
                  ? "bg-surface-subtle font-medium text-ink"
                  : "text-ink-muted hover:bg-surface-subtle hover:text-ink"
              }`}
            >
              <span className="truncate font-mono">{release.version}</span>
              {release.date && (
                <span className="shrink-0 text-[11px] text-ink-subtle">{release.date}</span>
              )}
            </a>
          ))}
        </nav>
      </div>
    </aside>
  );
}

export default function ChangelogView({ changelog }: { changelog: Changelog }) {
  const visibleReleases = changelog.releases.filter(
    (release) => release.version.toLowerCase() !== "unreleased",
  );
  const latest = visibleReleases[0];

  return (
    <main className="flex h-dvh w-full overflow-hidden bg-canvas text-ink">
      <section className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-y-auto">
            <article className="mx-auto w-full max-w-[760px] px-10 pb-16 pt-9">
              <header className="border-b border-border-subtle pb-7">
                <h1 className="text-[34px] font-semibold leading-tight tracking-[-0.01em] text-ink">
                  {changelog.title}
                </h1>
                {changelog.intro.length > 0 && (
                  <div className="mt-3 max-w-[620px] space-y-3 text-[14px] leading-6 tracking-[-0.005em] text-ink-muted">
                    {changelog.intro.map((paragraph, i) => (
                      <p key={i}>
                        <InlineMarkdown text={paragraph} />
                      </p>
                    ))}
                  </div>
                )}
                {latest && (
                  <div className="mt-5 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface px-2 py-1 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
                      <Tag size={12} strokeWidth={1.75} />
                      Latest {latest.version}
                    </span>
                    {latest.date && (
                      <span className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1">
                        Released {latest.date}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1">
                      {visibleReleases.length} {visibleReleases.length === 1 ? "entry" : "entries"}{" "}
                      total
                    </span>
                  </div>
                )}
              </header>

              <div className="mt-8 space-y-10">
                {visibleReleases.length === 0 ? (
                  <p className="text-[13.5px] text-ink-muted">
                    No releases have been recorded yet.
                  </p>
                ) : (
                  visibleReleases.map((release) => (
                    <ReleaseCard key={release.version} release={release} />
                  ))
                )}
              </div>
            </article>
          </div>
          <OutlinePanel releases={visibleReleases} />
        </div>
      </section>
    </main>
  );
}
