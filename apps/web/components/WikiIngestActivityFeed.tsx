"use client";

import type { WikiIngestActivityItemDto, WikiIngestActivityPageDto } from "@opencompany/protocol";
import { Alert, AlertDescription, AlertTitle } from "@opencompany/ui/components/alert";
import { Badge } from "@opencompany/ui/components/badge";
import { buttonVariants } from "@opencompany/ui/components/button";
import { Card, CardContent } from "@opencompany/ui/components/card";
import { Skeleton } from "@opencompany/ui/components/skeleton";
import { CircleAlert, CircleCheck, CircleMinus, Clock3, Loader2, RotateCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { listWikiIngestActivity } from "@/lib/wiki-source-api";
import { WIKI_SOURCE_PROVIDERS } from "@/lib/wiki-sources/registry";

const ACTIVITY_PAGE_SIZE = 20;
const MAX_VISIBLE_PAGE_LINKS = 6;

export function WikiIngestActivityFeed() {
  const [page, setPage] = useState<WikiIngestActivityPageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    void listWikiIngestActivity({ limit: ACTIVITY_PAGE_SIZE }).then(
      (nextPage) => {
        if (active) setPage(nextPage);
      },
      (reason: unknown) => {
        if (active) setError(errorMessage(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [retryNonce]);

  const loadMore = async () => {
    if (!page?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const nextPage = await listWikiIngestActivity({
        limit: ACTIVITY_PAGE_SIZE,
        cursor: page.nextCursor,
      });
      setPage((current) =>
        current
          ? {
              items: mergeActivityItems(current.items, nextPage.items),
              nextCursor: nextPage.nextCursor,
            }
          : nextPage,
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoadingMore(false);
    }
  };

  const initialLoading = page === null && error === null;
  return (
    <section aria-labelledby="wiki-ingestion-activity-title" className="flex flex-col gap-3">
      <div>
        <h2 id="wiki-ingestion-activity-title" className="text-[16px] font-semibold text-ink">
          Recent ingestion activity
        </h2>
        <p className="mt-1 text-[12.5px] leading-5 text-ink-subtle">
          See what sources sent to the Wiki and which pages the librarian changed.
        </p>
      </div>

      {initialLoading ? (
        <WikiIngestActivitySkeleton />
      ) : !page ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Activity didn&apos;t load</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <button
              type="button"
              onClick={() => {
                setPage(null);
                setError(null);
                setRetryNonce((value) => value + 1);
              }}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Try again
            </button>
          </AlertDescription>
        </Alert>
      ) : page.items.length === 0 ? (
        <Card className="bg-surface py-0">
          <CardContent className="flex flex-col items-center px-5 py-10 text-center">
            <Clock3 className="size-5 text-ink-subtle" />
            <p className="mt-3 text-[13px] font-medium text-ink">No ingestion activity yet</p>
            <p className="mt-1 max-w-md text-[12px] leading-5 text-ink-subtle">
              Runs will appear here after a connected source sends its first meeting, message,
              email, issue, or pull request.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="gap-0 overflow-hidden bg-surface py-0">
          <CardContent className="divide-y divide-border-subtle px-0">
            {page.items.map((item) => (
              <WikiIngestActivityRow key={item.id} item={item} />
            ))}
          </CardContent>
          {error ? (
            <div className="flex items-center justify-between gap-3 border-t border-border-subtle px-4 py-3 text-[12px] text-danger">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => void loadMore()}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Try again
              </button>
            </div>
          ) : page.nextCursor ? (
            <div className="border-t border-border-subtle px-4 py-3">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                {loadingMore ? <Loader2 className="animate-spin" /> : null}
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : null}
        </Card>
      )}
    </section>
  );
}

export function WikiIngestActivitySkeleton() {
  return (
    <Card aria-label="Loading Wiki ingestion activity" className="gap-0 py-0">
      <CardContent className="flex flex-col gap-4 px-5 py-5">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-start gap-3">
            <Skeleton className="size-7 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function WikiIngestActivityRow({ item }: { item: WikiIngestActivityItemDto }) {
  const outcome = OUTCOME_PRESENTATION[item.outcome];
  const Icon = outcome.Icon;
  const provider = providerName(item.provider);
  const at = item.completedAt ?? item.updatedAt;
  const sourceTitle = item.title?.trim() || `${provider} ${sourceTypeName(item.sourceType)}`;

  return (
    <article className="flex items-start gap-3 px-4 py-4 sm:px-5">
      <span
        className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ${outcome.iconClass}`}
      >
        <Icon className={item.outcome === "running" ? "size-3.5 animate-spin" : "size-3.5"} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 truncate text-[13px] font-medium text-ink" title={sourceTitle}>
            {sourceTitle}
          </p>
          <Badge variant={outcome.badgeVariant} className="px-1.5 py-0 text-[10.5px]">
            {outcome.label}
          </Badge>
        </div>
        <p className="mt-0.5 text-[11.5px] text-ink-subtle">
          {provider} · {formatRelativeTime(at)}
        </p>
        {item.reason ? (
          <p className="mt-1.5 text-[12px] leading-5 text-ink-muted">{item.reason}</p>
        ) : null}
        {item.outcome === "succeeded" && item.pages.length > 0 ? (
          <WikiActivityPageLinks pages={item.pages} />
        ) : null}
      </div>
    </article>
  );
}

function WikiActivityPageLinks({ pages }: { pages: WikiIngestActivityItemDto["pages"] }) {
  const visible = pages.slice(0, MAX_VISIBLE_PAGE_LINKS);
  const hiddenCount = pages.length - visible.length;
  return (
    <div className="mt-2 flex min-w-0 flex-wrap gap-1.5" aria-label="Pages touched">
      {visible.map((page) =>
        page.action === "deleted" ? (
          <span
            key={page.path}
            className="inline-flex max-w-[220px] truncate rounded-md border border-border-subtle px-2 py-1 text-[11px] text-ink-subtle line-through"
            title={`${page.title} (deleted)`}
          >
            {page.title}
          </span>
        ) : (
          <Link
            key={page.path}
            href={wikiPageHref(page.path)}
            className="inline-flex max-w-[220px] truncate rounded-md border border-border-subtle bg-canvas px-2 py-1 text-[11px] text-ink-muted transition-colors hover:border-border hover:bg-surface-hover hover:text-ink"
            title={`${page.title} · ${page.action}`}
          >
            {page.title}
          </Link>
        ),
      )}
      {hiddenCount > 0 ? (
        <span className="px-1.5 py-1 text-[11px] text-ink-subtle">+{hiddenCount} more</span>
      ) : null}
    </div>
  );
}

const OUTCOME_PRESENTATION = {
  succeeded: {
    label: "Succeeded",
    Icon: CircleCheck,
    badgeVariant: "success",
    iconClass: "bg-success-bg text-success",
  },
  skipped: {
    label: "Skipped",
    Icon: CircleMinus,
    badgeVariant: "secondary",
    iconClass: "bg-surface-muted text-ink-subtle",
  },
  failed: {
    label: "Failed",
    Icon: CircleAlert,
    badgeVariant: "destructive",
    iconClass: "bg-danger/10 text-danger",
  },
  running: {
    label: "Running",
    Icon: Loader2,
    badgeVariant: "info",
    iconClass: "bg-info-bg text-info",
  },
  queued: {
    label: "Queued",
    Icon: RotateCw,
    badgeVariant: "outline",
    iconClass: "bg-surface-muted text-ink-subtle",
  },
} as const;

function mergeActivityItems(
  current: WikiIngestActivityItemDto[],
  additions: WikiIngestActivityItemDto[],
) {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of additions) byId.set(item.id, item);
  return [...byId.values()];
}

function wikiPageHref(path: string) {
  return `/wiki/${path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

function providerName(provider: WikiIngestActivityItemDto["provider"]) {
  return WIKI_SOURCE_PROVIDERS.find((entry) => entry.id === provider)?.name ?? provider;
}

function sourceTypeName(sourceType: WikiIngestActivityItemDto["sourceType"]) {
  return sourceType === "activity" ? "activity" : sourceType;
}

function formatRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  const elapsedMs = Date.now() - timestamp;
  if (!Number.isFinite(timestamp) || elapsedMs < 30_000) return "just now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(timestamp);
}

function errorMessage(reason: unknown) {
  return reason instanceof Error && reason.message
    ? reason.message
    : "Wiki ingestion activity could not be loaded. Try again.";
}
