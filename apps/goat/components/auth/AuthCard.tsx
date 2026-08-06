"use client";

import { Button } from "@opencompany/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@opencompany/ui/components/card";
import { Input } from "@opencompany/ui/components/input";
import { Label } from "@opencompany/ui/components/label";
import { useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { requestMagicCode, startGoogleAuth, verifyMagicCode } from "@/lib/auth-actions";
import type { GoatAuthMethod } from "@/lib/auth-methods";

type AuthCardProps = {
  mode: "sign-in" | "sign-up";
  invitationToken?: string;
  prefillEmail?: string;
  lastUsedMethod: GoatAuthMethod | null;
  initialError?: string | null;
};

type Step = "request" | "code-sent";

function UsedLastBadge() {
  return (
    <span className="ml-auto rounded-full bg-surface-muted px-2 py-0.5 text-xs font-normal text-ink-muted">
      Used last time
    </span>
  );
}

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="size-4">
      <path
        fill="#4285F4"
        d="M19.6 10.23c0-.68-.06-1.36-.18-2H10v3.79h5.4a4.62 4.62 0 0 1-2 3.03v2.5h3.24c1.9-1.75 3-4.32 3-7.32Z"
      />
      <path
        fill="#34A853"
        d="M10 20c2.7 0 4.96-.89 6.62-2.42l-3.23-2.5c-.9.6-2.05.96-3.39.96-2.6 0-4.8-1.76-5.59-4.12H1.06v2.59A10 10 0 0 0 10 20Z"
      />
      <path
        fill="#FBBC05"
        d="M4.41 11.92a5.99 5.99 0 0 1 0-3.84V5.49H1.06a10 10 0 0 0 0 9.02l3.35-2.59Z"
      />
      <path
        fill="#EA4335"
        d="M10 3.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.96 9.96 0 0 0 10 0 10 10 0 0 0 1.06 5.49l3.35 2.59C5.2 5.72 7.4 3.96 10 3.96Z"
      />
    </svg>
  );
}

function GoogleSubmitButton({ lastUsedMethod }: { lastUsedMethod: GoatAuthMethod | null }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="outline"
      className="w-full justify-center gap-2"
      disabled={pending}
    >
      <GoogleGlyph />
      {pending ? "Redirecting…" : "Continue with Google"}
      {!pending && lastUsedMethod === "google" ? <UsedLastBadge /> : null}
    </Button>
  );
}

export function AuthCard({
  mode,
  invitationToken,
  prefillEmail,
  lastUsedMethod,
  initialError,
}: AuthCardProps) {
  const [step, setStep] = useState<Step>("request");
  const [email, setEmail] = useState(prefillEmail ?? "");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [isPending, startTransition] = useTransition();

  const isSignUp = mode === "sign-up";
  const title = isSignUp ? "Create your account" : "Welcome back";
  const description = invitationToken
    ? "You've been invited to join a workspace."
    : isSignUp
      ? "Set up your workspace in a minute."
      : "Sign in to your workspace.";

  function handleRequestCode() {
    setError(null);
    startTransition(async () => {
      const result = await requestMagicCode({
        email,
        ...(invitationToken ? { invitationToken } : {}),
      });
      if (result.ok) {
        setStep("code-sent");
      } else {
        setError(result.error);
      }
    });
  }

  function handleVerifyCode() {
    setError(null);
    startTransition(async () => {
      const result = await verifyMagicCode({
        email,
        code,
        ...(invitationToken ? { invitationToken } : {}),
      });
      // On success verifyMagicCode redirects server-side; only failure returns here.
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form action={startGoogleAuth}>
          {invitationToken ? (
            <input type="hidden" name="invitationToken" value={invitationToken} />
          ) : null}
          <GoogleSubmitButton lastUsedMethod={lastUsedMethod} />
        </form>

        <div className="flex items-center gap-3 text-xs text-ink-faint">
          <div className="h-px flex-1 bg-border" />
          or
          <div className="h-px flex-1 bg-border" />
        </div>

        {step === "request" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={isPending}
            />
            <Button
              type="button"
              className="w-full justify-center gap-2"
              onClick={handleRequestCode}
              disabled={isPending || !email.trim()}
            >
              Continue with email
              {lastUsedMethod === "magic_link" ? <UsedLastBadge /> : null}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor="code">Code</Label>
            <p className="text-sm text-ink-muted">Enter the code we sent to {email}.</p>
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={isPending}
            />
            <Button
              type="button"
              className="w-full justify-center"
              onClick={handleVerifyCode}
              disabled={isPending || !code.trim()}
            >
              Verify code
            </Button>
            <button
              type="button"
              className="text-sm text-ink-muted underline underline-offset-2 disabled:opacity-50"
              onClick={() => {
                setStep("request");
                setCode("");
                setError(null);
              }}
              disabled={isPending}
            >
              Use a different email
            </button>
          </div>
        )}

        {error ? (
          <p className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="justify-center text-sm text-ink-muted">
        {isSignUp ? (
          <span>
            Already have an account?{" "}
            <a className="text-ink underline underline-offset-2" href="/signin">
              Sign in
            </a>
          </span>
        ) : (
          <span>
            New here?{" "}
            <a className="text-ink underline underline-offset-2" href="/signup">
              Create an account
            </a>
          </span>
        )}
      </CardFooter>
    </Card>
  );
}
