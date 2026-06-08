import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Space = "personal" | "workspace";

export function SpaceSwitcher({
  activeSpace,
  workspaceName,
  workspaceHref = "/",
  personalHref = "/personal",
}: {
  activeSpace: Space;
  workspaceName: string;
  workspaceHref?: string;
  personalHref?: string;
}) {
  return (
    <div className="px-2 pb-2">
      <nav
        aria-label="Space"
        className="grid grid-cols-2 gap-0.5 rounded-md border border-border bg-surface/45 p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.36)]"
      >
        <SpaceLink href={personalHref} active={activeSpace === "personal"}>
          Personal
        </SpaceLink>
        <SpaceLink
          href={workspaceHref}
          active={activeSpace === "workspace"}
          title={workspaceName}
        >
          {workspaceName}
        </SpaceLink>
      </nav>
    </div>
  );
}

function SpaceLink({
  href,
  active,
  title,
  children,
}: {
  href: string;
  active: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      title={title}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-6 min-w-0 items-center justify-center rounded-[5px] px-1.5 text-[11.5px] font-medium tracking-[-0.005em] transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20",
        active
          ? "bg-surface-active text-ink shadow-[inset_0_0_0_1px_rgba(15,15,15,0.06),0_1px_1px_rgba(15,15,15,0.05)]"
          : "text-ink-subtle hover:bg-surface-hover hover:text-ink",
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
    </Link>
  );
}
