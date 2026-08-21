"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useId } from "react";

type AppError = Error & { digest?: string };

export function AppErrorState({ error, reset }: { error: AppError; reset: () => void }) {
  const clientSupportId = `client_${useId().replace(/[^a-zA-Z0-9]/gu, "")}`;
  const supportId = error.digest ?? clientSupportId;

  useEffect(() => {
    if (error.digest) return;

    Sentry.captureException(error, {
      tags: {
        event: "opencompany.web_client_error_boundary",
        support_id: clientSupportId,
      },
    });
  }, [clientSupportId, error]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-6 py-12 text-ink">
      <section className="w-full max-w-md rounded-xl border border-border bg-surface p-7 shadow-sm">
        <p className="text-sm font-medium text-ink-muted">opencompany</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          We couldn&apos;t open this page
        </h1>
        <p className="mt-3 text-sm leading-6 text-ink-muted">
          A problem on our side stopped the page from loading. We&apos;ve recorded it so we can
          investigate.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-6 inline-flex h-9 items-center justify-center rounded-md bg-ink px-4 text-sm font-medium text-canvas outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink-muted focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        >
          Try again
        </button>
        {supportId ? (
          <p className="mt-5 break-all text-xs text-ink-subtle">
            Support ID: <span className="font-mono">{supportId}</span>
          </p>
        ) : null}
      </section>
    </main>
  );
}
