import { Sparkles } from "lucide-react";

export function SidebarPreviewBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-[3px] bg-ink/[0.08] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.04em] text-ink-subtle">
      <Sparkles size={10} strokeWidth={1.8} className="text-ink/55" aria-hidden="true" />
      Private beta
    </span>
  );
}
