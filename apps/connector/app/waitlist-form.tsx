"use client";

import { buttonVariants } from "@opencompany/ui/components/button";
import { cn } from "@opencompany/ui/lib/utils";
import { useActionState } from "react";
import { joinWaitlist, type WaitlistState } from "./waitlist-actions";

const initialState: WaitlistState = { status: "idle" };

export function WaitlistForm() {
  const [state, formAction, pending] = useActionState(joinWaitlist, initialState);

  if (state.status === "success") {
    return (
      <p className="text-sm font-medium text-foreground" role="status">
        <span aria-hidden className="text-muted-foreground">
          ›{" "}
        </span>
        You&apos;re on the list. We&apos;ll be in touch.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex w-full max-w-md flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          placeholder="you@company.com"
          aria-label="Work email"
          className="h-11 w-full rounded-none border border-border bg-background px-3 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending}
          className={cn(
            buttonVariants({ size: "lg" }),
            "rounded-none font-mono whitespace-nowrap disabled:opacity-60",
          )}
        >
          {pending ? "Joining…" : "Sign up to waitlist"}
        </button>
      </div>
      {state.status === "error" ? (
        <p className="text-xs text-destructive" role="alert">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
