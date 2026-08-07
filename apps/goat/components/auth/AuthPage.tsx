import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/AuthCard";
import { GoatMark } from "@/components/GoatMark";
import { currentGoatIdentity } from "@/lib/auth";
import { readGoatOrganizationOptions, readLastGoatAuthMethod } from "@/lib/auth-methods";

type AuthPageSearchParams = Promise<{ invitation_token?: string; email?: string; error?: string }>;

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_state: "That sign-in link expired. Try continuing with Google again.",
  oauth_failed: "We couldn't complete Google sign-in. Try again.",
};

export async function AuthPage({
  mode,
  searchParams,
}: {
  mode: "sign-in" | "sign-up";
  searchParams: AuthPageSearchParams;
}) {
  const identity = await currentGoatIdentity({ optional: true });
  if (identity) redirect(identity.workspaces.length > 0 ? "/" : "/onboarding");

  const [params, lastUsedMethod, organizationOptions] = await Promise.all([
    searchParams,
    readLastGoatAuthMethod(),
    readGoatOrganizationOptions(),
  ]);

  return (
    <main className="relative flex min-h-dvh w-full flex-col items-center justify-center overflow-hidden bg-canvas px-6 py-12 text-ink">
      {/* Subtle grid backdrop, faded toward the edges so the card floats. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.55] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_45%,black,transparent)]"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--color-border-subtle) 1px, transparent 1px), linear-gradient(to bottom, var(--color-border-subtle) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
        }}
      />

      <div className="relative flex w-full max-w-sm flex-col items-center">
        <a
          href="https://opencompany.chat"
          className="mb-8 flex items-center gap-2.5 text-ink"
          aria-label="opencompany home"
        >
          <GoatMark className="size-6 animate-goat-mark-spin" />
          <span className="font-medium font-mono text-[17px] tracking-tight">opencompany</span>
        </a>

        <AuthCard
          mode={mode}
          lastUsedMethod={lastUsedMethod}
          organizationOptions={organizationOptions}
          initialError={params.error ? (OAUTH_ERROR_MESSAGES[params.error] ?? null) : null}
          {...(params.invitation_token ? { invitationToken: params.invitation_token } : {})}
          {...(params.email ? { prefillEmail: params.email } : {})}
        />

        <p className="mt-6 text-balance text-center text-xs leading-relaxed text-ink-faint">
          By continuing you agree to our{" "}
          <a
            href="https://opencompany.chat/terms"
            className="text-ink-subtle underline underline-offset-2 transition-colors hover:text-ink-muted"
          >
            Terms
          </a>{" "}
          and{" "}
          <a
            href="https://opencompany.chat/privacy"
            className="text-ink-subtle underline underline-offset-2 transition-colors hover:text-ink-muted"
          >
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </main>
  );
}
