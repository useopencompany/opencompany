import { cn } from "@opencompany/ui/lib/utils";
import Link from "next/link";
import { Mark } from "../Mark";
import { BODY, GRID, SHELL } from "./tokens";

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "Use cases", href: "/use-cases" },
      { label: "Pricing", href: "/pricing" },
      { label: "Slack", href: "/slack" },
      { label: "Changelog", href: "https://my.opencompany.chat/changelog" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "Blog", href: "/blog" },
      { label: "Media kit", href: "/media" },
      { label: "Request demo", href: "/request-demo" },
    ],
  },
  {
    heading: "Connect",
    links: [
      { label: "GitHub", href: "https://github.com/useopencompany/opencompany" },
      { label: "X", href: "https://x.com/useopencompany" },
      { label: "LinkedIn", href: "https://www.linkedin.com/company/useopencompany" },
    ],
  },
];

const LEGAL = [
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
  { label: "Support", href: "/support" },
  { label: "License", href: "https://github.com/useopencompany/opencompany/blob/main/LICENSE" },
  {
    label: "Security",
    href: "https://github.com/useopencompany/opencompany/blob/main/SECURITY.md",
  },
];

function FooterLink({ href, label }: { href: string; label: string }) {
  const className = cn(BODY, "text-foreground/50 transition-colors hover:text-foreground");
  return href.startsWith("/") ? (
    <Link href={href} className={className}>
      {label}
    </Link>
  ) : (
    <a href={href} className={className}>
      {label}
    </a>
  );
}

/**
 * Footer on the same 12-column grid: mark alone in the left gutter, link
 * columns at 5/8/11, and a wide gap before the legal row so the page ends on
 * air rather than on links.
 */
export function V2Footer() {
  return (
    <footer className="border-border border-t pt-10 pb-10">
      <div className={SHELL}>
        <div className={GRID}>
          <div className="col-span-12 sm:col-span-4">
            <Mark className="size-5 text-foreground/70" />
          </div>
          {COLUMNS.map(({ heading, links }, i) => (
            <div
              key={heading}
              className={cn(
                "col-span-6 mt-8 sm:mt-0",
                i === 0 && "sm:col-span-2 sm:col-start-5",
                i === 1 && "sm:col-span-2 sm:col-start-8",
                i === 2 && "sm:col-span-2 sm:col-start-11",
              )}
            >
              <p className={cn(BODY, "text-foreground")}>{heading}</p>
              <div className="mt-1.5 flex flex-col items-start gap-1">
                {links.map((link) => (
                  <FooterLink key={link.label} {...link} />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className={cn(GRID, "mt-24 sm:mt-48")}>
          <p className={cn(BODY, "col-span-12 text-foreground/50 sm:col-span-4")}>
            © {new Date().getFullYear()} opencompany
          </p>
          <div className="col-span-12 mt-4 flex flex-wrap gap-x-6 gap-y-2 sm:col-span-5 sm:col-start-5 sm:mt-0">
            {LEGAL.map((link) => (
              <FooterLink key={link.label} {...link} />
            ))}
          </div>
          <p
            className={cn(
              BODY,
              "col-span-12 mt-4 text-foreground/50 sm:col-span-3 sm:col-start-10 sm:mt-0 sm:text-right",
            )}
          >
            Open source, MIT licensed
          </p>
        </div>
      </div>
    </footer>
  );
}
