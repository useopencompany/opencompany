"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/blog", label: "Blog", external: false },
  { href: "https://my.opencompany.chat/changelog", label: "Changelog", external: true },
  { href: "/pricing", label: "Pricing", external: false },
] as const;

function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || (href === "/blog" && pathname.startsWith("/blog/"));
}

export function TopNavLinks({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();

  return navItems.map((item) => {
    const isActive = !item.external && isActivePath(pathname, item.href);
    const className = `font-sans text-[13px] transition-[color,opacity] hover:text-ink hover:opacity-100 ${
      isActive ? "text-ink opacity-100" : "text-ink-muted opacity-55"
    } ${mobile ? "block px-3 py-2" : ""}`;

    return item.external ? (
      <a key={item.href} href={item.href} className={className}>
        {item.label}
      </a>
    ) : (
      <Link
        key={item.href}
        href={item.href}
        className={className}
        aria-current={isActive ? "page" : undefined}
      >
        {item.label}
      </Link>
    );
  });
}
