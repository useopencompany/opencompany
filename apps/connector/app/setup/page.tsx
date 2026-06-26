import { buttonVariants } from "@opencompany/ui/components/button";
import { cn } from "@opencompany/ui/lib/utils";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import { SetupFlow } from "./setup-flow";

export default async function SetupPage() {
  const { user } = await withAuth();

  if (!user) {
    redirect("/auth/sign-in");
  }

  const name = user.firstName ?? user.email;

  return (
    <main className="min-h-screen bg-background font-mono">
      <section className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-6 py-16 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-sm font-medium text-muted-foreground">Signed in as {name}</p>
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

        <SetupFlow />
      </section>
    </main>
  );
}
