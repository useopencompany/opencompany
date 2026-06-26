import { buttonVariants } from "@opencompany/ui/components/button";
import { cn } from "@opencompany/ui/lib/utils";
import { redirect } from "next/navigation";
import { currentConnectorUser, displayConnectorUserName } from "@/lib/auth";
import { loadConnectorSetupState } from "@/lib/setup/data";
import { setupStatusMessage } from "@/lib/setup/state";
import { SetupFlow } from "./setup-flow";

type SetupPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SetupPage({ searchParams }: SetupPageProps) {
  const user = await currentConnectorUser();
  const state = await loadConnectorSetupState(user.id);

  if (state.organization?.setupCompletedAt) {
    redirect("/app");
  }

  const params = await searchParams;
  const notice = setupStatusMessage(toUrlSearchParams(params));

  return (
    <main className="min-h-screen bg-background font-mono">
      <section className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-6 py-16 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-sm font-medium text-muted-foreground">
            Signed in as {displayConnectorUserName(user)}
          </p>
          <a
            href="/auth/sign-out"
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "rounded-none font-mono",
            )}
          >
            Sign out
          </a>
        </div>

        <h1 className="mt-6 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Connector setup
        </h1>

        <SetupFlow initialState={state} notice={notice} />
      </section>
    </main>
  );
}

function toUrlSearchParams(params: Record<string, string | string[] | undefined>) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) searchParams.append(key, item);
      continue;
    }
    if (typeof value === "string") searchParams.set(key, value);
  }
  return searchParams;
}
