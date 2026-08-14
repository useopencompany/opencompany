import { LinkedInIcon, XIcon, YouTubeIcon } from "@opencompany/ui/icons";
import { DayCount } from "./DayCount";
import { Mark } from "./Mark";

const SOCIAL_LINKS = [
  {
    label: "YouTube",
    href: "https://www.youtube.com/channel/UCACbvOjHOVYwKDfz_q7VXlA",
    Icon: YouTubeIcon,
  },
  { label: "X", href: "https://x.com/useopencompany", Icon: XIcon },
  {
    label: "LinkedIn",
    href: "https://www.linkedin.com/company/useopencompany",
    Icon: LinkedInIcon,
  },
];

export function SiteFooter() {
  return (
    <footer className="border-border border-t">
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 px-6 py-10 sm:grid sm:grid-cols-[1fr_auto_1fr]">
        <div className="flex items-center gap-3 text-ink sm:justify-self-start">
          <div className="flex items-center gap-2">
            <Mark className="size-4" />
            <span className="font-medium font-mono text-[14px] tracking-tight">opencompany</span>
          </div>
          <span aria-hidden="true" className="h-3 w-px bg-border" />
          <DayCount />
        </div>
        <p className="font-mono text-[12px] text-ink-subtle sm:justify-self-center">
          © {new Date().getFullYear()} opencompany. All rights reserved.
        </p>
        <nav aria-label="Social media" className="sm:justify-self-end">
          <ul className="flex items-center gap-1">
            {SOCIAL_LINKS.map(({ label, href, Icon }) => (
              <li key={label}>
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="flex size-7 items-center justify-center text-ink-subtle opacity-60 transition-[color,opacity] hover:text-violet-600 hover:opacity-100"
                >
                  <span className="sr-only">{label}</span>
                  <Icon className="size-3.5" />
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
