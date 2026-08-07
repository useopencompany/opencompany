import Link from "next/link";
import { BrandMark } from "./BrandMark";
import { Cta } from "./Cta";

const navLinkClassName = "font-mono text-[13px] text-ink-muted transition-colors hover:text-ink";

export function TopNav() {
  return (
    <header className="sticky top-0 z-50 bg-background">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2 text-ink" aria-label="opencompany home">
          <BrandMark className="size-5 animate-goat-mark-spin" />
          <span className="font-medium font-mono text-[15px] tracking-tight">opencompany</span>
        </Link>
        <nav aria-label="Primary navigation" className="hidden items-center gap-6 sm:flex">
          <Link href="/blog" className={navLinkClassName}>
            blog
          </Link>
          <a href="https://my.opencompany.chat/docs" className={navLinkClassName}>
            docs
          </a>
          <a href="https://my.opencompany.chat/changelog" className={navLinkClassName}>
            changelog
          </a>
          <Cta href="https://my.opencompany.chat" className="px-3 py-1.5 text-[12px]">
            Sign up
          </Cta>
        </nav>

        <details className="group relative sm:hidden">
          <summary className="flex size-8 cursor-pointer list-none items-center justify-center border border-border text-ink transition-colors hover:border-violet-500/40 hover:text-violet-600 [&::-webkit-details-marker]:hidden">
            <span className="sr-only">Toggle navigation menu</span>
            <svg
              aria-hidden="true"
              className="size-4 group-open:hidden"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="1.75"
            >
              <path strokeLinecap="round" d="M4 7h16M4 12h16M4 17h16" />
            </svg>
            <svg
              aria-hidden="true"
              className="hidden size-4 group-open:block"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="1.75"
            >
              <path strokeLinecap="round" d="m6 6 12 12M18 6 6 18" />
            </svg>
          </summary>

          <nav
            aria-label="Mobile navigation"
            className="absolute top-[calc(100%+0.5rem)] right-0 w-48 border border-border bg-background p-2 shadow-lg"
          >
            <Link href="/blog" className={`${navLinkClassName} block px-3 py-2`}>
              blog
            </Link>
            <a
              href="https://my.opencompany.chat/docs"
              className={`${navLinkClassName} block px-3 py-2`}
            >
              docs
            </a>
            <a
              href="https://my.opencompany.chat/changelog"
              className={`${navLinkClassName} block px-3 py-2`}
            >
              changelog
            </a>
            <Cta
              href="https://my.opencompany.chat"
              className="mt-1 w-full justify-center px-3 py-2 text-[12px]"
            >
              Sign up
            </Cta>
          </nav>
        </details>
      </div>
    </header>
  );
}
