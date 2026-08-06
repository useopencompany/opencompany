import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/AuthCard";
import { currentGoatUser } from "@/lib/auth";
import { readLastGoatAuthMethod } from "@/lib/auth-methods";

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
  const context = await currentGoatUser({ optional: true });
  if (context) redirect("/");

  const [params, lastUsedMethod] = await Promise.all([searchParams, readLastGoatAuthMethod()]);

  return (
    <main className="flex min-h-dvh w-full items-center justify-center bg-canvas px-6 py-12 text-ink">
      <AuthCard
        mode={mode}
        lastUsedMethod={lastUsedMethod}
        initialError={params.error ? (OAUTH_ERROR_MESSAGES[params.error] ?? null) : null}
        {...(params.invitation_token ? { invitationToken: params.invitation_token } : {})}
        {...(params.email ? { prefillEmail: params.email } : {})}
      />
    </main>
  );
}
