"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ComponentProps, useCallback, useRef } from "react";

type IntentPrefetchLinkProps = Omit<
  ComponentProps<typeof Link>,
  "href" | "prefetch" | "onMouseEnter" | "onFocus" | "onTouchStart"
> & {
  href: string;
  onIntent?: () => void;
};

// Dynamic authenticated routes can fan out into several API reads. Warm them once the user shows
// intent instead of asking Next.js to render every visible destination speculatively.
export function IntentPrefetchLink({ href, onIntent, ...props }: IntentPrefetchLinkProps) {
  const router = useRouter();
  const prefetchedHref = useRef<string | null>(null);
  const prefetch = useCallback(() => {
    if (prefetchedHref.current === href) return;
    prefetchedHref.current = href;
    router.prefetch(href);
    onIntent?.();
  }, [href, onIntent, router]);

  return (
    <Link
      {...props}
      href={href}
      prefetch={false}
      onMouseEnter={prefetch}
      onFocus={prefetch}
      onTouchStart={prefetch}
    />
  );
}
