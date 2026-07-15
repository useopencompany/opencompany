import { Cta } from "./Cta";
import { GoatMark } from "./GoatMark";

export function TopNav() {
  return (
    <header className="sticky top-0 z-50 bg-background">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
        <a href="#" className="flex items-center gap-2 text-ink" aria-label="opencompany home">
          <GoatMark className="size-5" />
          <span className="font-medium font-mono text-[15px] tracking-tight">opencompany</span>
        </a>
        <nav className="flex items-center gap-6">
          <a
            href="https://my.opencompany.chat/docs"
            className="font-mono text-[13px] text-ink-muted transition-colors hover:text-ink"
          >
            docs
          </a>
          <a
            href="#"
            className="font-mono text-[13px] text-ink-muted transition-colors hover:text-ink"
          >
            changelog
          </a>
          <Cta className="px-3.5 py-2">Signup</Cta>
        </nav>
      </div>
    </header>
  );
}
