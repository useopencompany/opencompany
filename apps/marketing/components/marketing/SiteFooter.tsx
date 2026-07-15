import { Cta } from "./Cta";
import { DayCount } from "./DayCount";
import { GoatMark } from "./GoatMark";

export function SiteFooter() {
  return (
    <footer className="border-border border-t">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 px-6 py-10 sm:flex-row">
        <div className="flex items-center gap-3 text-ink">
          <div className="flex items-center gap-2">
            <GoatMark className="size-4" />
            <span className="font-medium font-mono text-[14px] tracking-tight">opencompany</span>
          </div>
          <span aria-hidden="true" className="h-3 w-px bg-border" />
          <DayCount />
        </div>
        <p className="font-mono text-[12px] text-ink-subtle">
          © {new Date().getFullYear()} OpenCompany. All rights reserved.
        </p>
        <Cta variant="secondary">Signup</Cta>
      </div>
    </footer>
  );
}
