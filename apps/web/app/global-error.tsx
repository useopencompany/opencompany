"use client";

import { AppErrorState } from "@/components/AppErrorState";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="bg-canvas font-sans text-ink antialiased">
        <AppErrorState error={error} reset={reset} />
      </body>
    </html>
  );
}
