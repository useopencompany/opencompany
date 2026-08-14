"use client";

import { cn } from "@opencompany/ui/lib/utils";
import { useId, useState } from "react";

type Status = "idle" | "loading" | "success" | "error";

type EmailCaptureFormProps = {
  className?: string;
  ctaLabel?: string;
};

// Squared, monospace email capture — one input, one action, styled to match
// Cta.tsx's solid-ink button so the pair reads as a single control.
export function EmailCaptureForm({
  className,
  ctaLabel = "Get early access",
}: EmailCaptureFormProps) {
  const inputId = useId();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  if (status === "success") {
    return (
      <p className={cn("font-mono text-[13px] text-ink", className)}>
        You're on the list — we'll email you when it's your turn.
      </p>
    );
  }

  return (
    <form
      className={cn("w-full max-w-md", className)}
      onSubmit={async (event) => {
        event.preventDefault();
        setStatus("loading");
        setError(null);

        try {
          const response = await fetch("/api/early-access", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, source: "ship" }),
          });

          if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw new Error(body?.error ?? "Something went wrong. Try again.");
          }

          setStatus("success");
        } catch (err) {
          setStatus("error");
          setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
        }
      }}
    >
      <div className="flex items-stretch border border-border bg-background">
        <label htmlFor={inputId} className="sr-only">
          Work email
        </label>
        <input
          id={inputId}
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@company.example"
          className="w-full min-w-0 bg-transparent px-3 py-2.5 font-mono text-[13px] text-ink outline-none placeholder:text-ink-subtle"
        />
        <button
          type="submit"
          disabled={status === "loading"}
          className="shrink-0 whitespace-nowrap bg-black px-4 py-2.5 font-medium font-mono text-[13px] text-white transition hover:bg-black/85 disabled:opacity-60"
        >
          {status === "loading" ? "Sending…" : ctaLabel}
        </button>
      </div>
      {error ? <p className="mt-2 font-mono text-[12px] text-destructive">{error}</p> : null}
    </form>
  );
}
