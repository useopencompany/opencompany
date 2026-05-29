import { ArrowRight } from "lucide-react";
import Link from "next/link";

type DocsCardProps = {
  href: string;
  title: string;
  description: string;
};

export function DocsCard({ href, title, description }: DocsCardProps) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-1.5 rounded-xl border border-border bg-surface/60 p-5 transition-all duration-150 hover:border-border-strong hover:bg-surface/90 hover:shadow-[0_2px_8px_rgba(0,0,0,0.05)]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-ink">{title}</span>
        <ArrowRight
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-ink-subtle transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-ink-muted"
        />
      </div>
      <p className="text-[13px] leading-[1.6] tracking-[-0.003em] text-ink-muted">{description}</p>
    </Link>
  );
}
