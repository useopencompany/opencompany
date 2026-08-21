"use client";

import { AppErrorState } from "@/components/AppErrorState";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <AppErrorState error={error} reset={reset} />;
}
