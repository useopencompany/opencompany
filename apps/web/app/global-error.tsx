"use client";

import { captureException } from "@opencompany/observability";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, {
      event: "opencompany.web_global_error",
      digest: error.digest,
      ...readBrowserErrorContext(),
    });
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main
          style={{
            alignItems: "center",
            background: "var(--color-canvas, #f7f7f5)",
            color: "var(--color-ink, #111)",
            display: "flex",
            fontFamily: "system-ui, sans-serif",
            justifyContent: "center",
            minHeight: "100vh",
            padding: "24px",
          }}
        >
          <div style={{ maxWidth: "360px", textAlign: "center" }}>
            <h1 style={{ fontSize: "20px", margin: 0 }}>Something went wrong</h1>
            <p style={{ color: "var(--color-ink-muted, #666)", fontSize: "14px", lineHeight: 1.5 }}>
              Please try again. We have captured the error.
            </p>
            <button
              type="button"
              onClick={reset}
              style={{
                background: "var(--color-ink, #111)",
                border: 0,
                borderRadius: "6px",
                color: "var(--color-canvas, #fff)",
                cursor: "pointer",
                fontSize: "14px",
                padding: "10px 14px",
              }}
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}

function readBrowserErrorContext() {
  if (typeof window === "undefined") return {};

  return {
    browser_pathname: window.location.pathname,
    browser_online: navigator.onLine,
    document_visibility_state: document.visibilityState,
  };
}
