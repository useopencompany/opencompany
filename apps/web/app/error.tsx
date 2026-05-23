"use client";

import { captureException } from "@opencompany/observability";
import { useEffect } from "react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, {
      event: "opencompany.web_app_error",
      digest: error.digest,
      ...readBrowserErrorContext(),
    });
  }, [error]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-paper px-6 text-ink">
      <div className="max-w-sm text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted">Please try again. We have captured the error.</p>
        <button
          type="button"
          onClick={reset}
          className="mt-5 rounded-md bg-ink px-4 py-2 text-sm font-medium text-paper"
        >
          Try again
        </button>
      </div>
    </main>
  );
}

function readBrowserErrorContext() {
  if (typeof window === "undefined") return {};

  return {
    browser_url: window.location.href,
    browser_pathname: window.location.pathname,
    browser_online: navigator.onLine,
    document_visibility_state: document.visibilityState,
  };
}
