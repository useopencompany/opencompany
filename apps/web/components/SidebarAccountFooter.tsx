"use client";

import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  ChevronRight,
  CircleHelp,
  LogOut,
  MessageSquarePlus,
  ScrollText,
  Settings,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import FeedbackDialog from "@/components/FeedbackDialog";

const STATUS_PAGE_URL = "https://myopencompany.betteruptime.com";
const STATUS_PAGE_JSON_URL = `${STATUS_PAGE_URL}/index.json`;
const STATUS_PAGE_QUERY_STALE_TIME_MS = 60 * 1000;
const ACCOUNT_MENU_ITEM_CLASS =
  "flex h-[29px] w-full items-center gap-2.5 px-3 text-left text-[13px] font-medium tracking-[-0.005em] text-ink transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:bg-surface-hover";

type StatusPageAggregateState = "operational" | "degraded" | "downtime" | "maintenance";

type Props = {
  userName: string;
  userEmail: string;
  subtitle: string;
  trailing?: ReactNode;
  // Where the "Settings" menu item links. Defaults to the workspace settings; the personal surface
  // overrides it to its own lightweight settings page.
  settingsHref?: string;
};

async function fetchStatusPageAggregateState(): Promise<StatusPageAggregateState> {
  const response = await fetch(STATUS_PAGE_JSON_URL, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Status page request failed with ${response.status}.`);
  }

  const payload: unknown = await response.json();
  const aggregateState = readAggregateState(payload);
  if (!aggregateState) {
    throw new Error("Status page response did not include a recognized aggregate state.");
  }
  return aggregateState;
}

function readAggregateState(payload: unknown): StatusPageAggregateState | null {
  if (!isRecord(payload)) return null;
  const data = payload.data;
  if (!isRecord(data)) return null;
  const attributes = data.attributes;
  if (!isRecord(attributes)) return null;
  const aggregateState = attributes.aggregate_state;
  if (
    aggregateState === "operational" ||
    aggregateState === "degraded" ||
    aggregateState === "downtime" ||
    aggregateState === "maintenance"
  ) {
    return aggregateState;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function statusPageMeta({
  aggregateState,
  pending,
  error,
}: {
  aggregateState: StatusPageAggregateState | undefined;
  pending: boolean;
  error: boolean;
}) {
  if (pending) {
    return {
      label: "Checking status",
      description: "Checking status",
      dotClassName: "bg-ink-subtle/45",
    };
  }
  if (error || !aggregateState) {
    return {
      label: "Status unavailable",
      description: "Status unavailable",
      dotClassName: "bg-ink-subtle/45",
    };
  }
  if (aggregateState === "operational") {
    return {
      label: "All systems operational",
      description: "All systems operational",
      dotClassName: "bg-success",
    };
  }
  if (aggregateState === "downtime") {
    return {
      label: "Service disruption",
      description: "Service disruption",
      dotClassName: "bg-danger",
    };
  }
  if (aggregateState === "maintenance") {
    return {
      label: "Maintenance",
      description: "Maintenance",
      dotClassName: "bg-warning",
    };
  }
  return {
    label: "Service degraded",
    description: "Service degraded",
    dotClassName: "bg-warning",
  };
}

function StatusPageMenuItem({ onClose }: { onClose: () => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["status-page", STATUS_PAGE_JSON_URL],
    queryFn: fetchStatusPageAggregateState,
    staleTime: STATUS_PAGE_QUERY_STALE_TIME_MS,
    retry: false,
  });
  const meta = statusPageMeta({ aggregateState: data, pending: isLoading, error: isError });

  return (
    <a
      href={STATUS_PAGE_URL}
      target="_blank"
      rel="noreferrer"
      onClick={onClose}
      className="mt-3 flex min-w-0 items-center gap-2 rounded-md py-1 text-[12.5px] leading-4 text-ink-subtle transition-colors duration-150 hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20"
      title={meta.description}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full shadow-[0_0_0_2px_rgba(15,15,15,0.04)] ${meta.dotClassName}`}
      />
      <span className="truncate">{meta.label}</span>
    </a>
  );
}

function AccountMenu({
  userName,
  userEmail,
  settingsHref,
  onClose,
  onFeedbackOpen,
}: {
  userName: string;
  userEmail: string;
  settingsHref: string;
  onClose: () => void;
  onFeedbackOpen: () => void;
}) {
  const menuItems: Array<{
    icon: LucideIcon;
    label: string;
    detail?: string;
    href?: string;
    action?: () => void;
  }> = [
    { icon: MessageSquarePlus, label: "Feedback", action: onFeedbackOpen },
    { icon: Settings, label: "Settings", href: settingsHref },
    { icon: ScrollText, label: "Changelog", href: "/changelog" },
    { icon: CircleHelp, label: "Docs", href: "/docs" },
  ];

  return (
    <div className="absolute bottom-[60px] left-1 z-20 w-[220px] overflow-hidden rounded-lg border border-black/[0.08] bg-surface-raised shadow-[0_16px_36px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.08)]">
      <div className="px-3 pb-3 pt-3">
        <div className="text-[13.5px] font-medium leading-[1.2] tracking-[-0.01em] text-ink">
          {userName}
        </div>
        <div className="mt-0.5 text-[12.5px] leading-[1.2] text-ink-subtle">{userEmail}</div>
        <StatusPageMenuItem onClose={onClose} />
      </div>

      <div className="border-t border-black/[0.07] py-2">
        {menuItems.map(({ icon: Icon, label, detail, href, action }) => {
          const inner = (
            <>
              <Icon size={15.5} strokeWidth={1.8} className="shrink-0 text-ink/60" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {detail && <span className="text-ink-subtle">{detail}</span>}
              {(detail || href || label === "Help") && (
                <ChevronRight size={14} strokeWidth={1.8} className="shrink-0 text-ink/35" />
              )}
            </>
          );

          if (href) {
            return (
              <Link key={label} href={href} onClick={onClose} className={ACCOUNT_MENU_ITEM_CLASS}>
                {inner}
              </Link>
            );
          }
          return (
            <button
              key={label}
              type="button"
              onClick={() => {
                action?.();
                onClose();
              }}
              className={ACCOUNT_MENU_ITEM_CLASS}
            >
              {inner}
            </button>
          );
        })}
      </div>

      <div className="border-t border-black/[0.07] py-2">
        <a href="/auth/sign-out" onClick={onClose} className={ACCOUNT_MENU_ITEM_CLASS}>
          <LogOut size={15.5} strokeWidth={1.8} className="shrink-0 text-ink/60" />
          <span>Log Out</span>
        </a>
      </div>
    </div>
  );
}

export function SidebarAccountFooter({
  userName,
  userEmail,
  subtitle,
  trailing,
  settingsHref = "/company/settings",
}: Props) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const footerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!accountMenuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (!footerRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAccountMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [accountMenuOpen]);

  return (
    <>
      <div ref={footerRef} className="relative flex items-center gap-2.5 px-3 py-2.5">
        {accountMenuOpen && (
          <AccountMenu
            userName={userName}
            userEmail={userEmail}
            settingsHref={settingsHref}
            onClose={() => setAccountMenuOpen(false)}
            onFeedbackOpen={() => setFeedbackOpen(true)}
          />
        )}
        <button
          type="button"
          aria-label="Open account menu"
          aria-expanded={accountMenuOpen}
          onClick={() => setAccountMenuOpen((open) => !open)}
          className={`-mx-1.5 flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1.5 transition-colors duration-150 hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-ink/20 ${
            accountMenuOpen ? "bg-surface-active" : ""
          }`}
        >
          <div
            aria-hidden
            className="h-6 w-6 shrink-0 rounded-full ring-1 ring-black/[0.06]"
            style={{
              background:
                "radial-gradient(circle at 30% 30%, #c9d9ff 0%, #3b5bdb 35%, #0b1224 80%)",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18), 0 1px 2px rgba(0,0,0,0.08)",
            }}
          />
          <div className="flex min-w-0 flex-col leading-tight text-left">
            <span
              title={userEmail}
              className="truncate text-[12.5px] font-medium tracking-[-0.005em] text-ink"
            >
              {userName}
            </span>
            <span className="truncate text-[11px] text-ink-subtle">{subtitle}</span>
          </div>
        </button>
        {trailing}
      </div>
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </>
  );
}
