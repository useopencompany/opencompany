import { Mark } from "@/components/Mark";
import { DesktopReturnRedirect } from "./DesktopReturnRedirect";

type ReturnSearchParams = Promise<{ token?: string }>;

// Terminal "return to the app" page shown in the system browser after the
// desktop Google sign-in leg completes. It never signs the browser in — the
// sealed token is handed to the app over the opencompany:// deep link, and the
// desktop redemption is what establishes a session.
export default async function DesktopReturnPage({
  searchParams,
}: {
  searchParams: ReturnSearchParams;
}) {
  const { token } = await searchParams;
  const deepLink = token ? `opencompany://auth/callback?token=${encodeURIComponent(token)}` : null;

  return (
    <main className="relative flex min-h-dvh w-full flex-col items-center justify-center overflow-hidden bg-canvas px-6 py-12 text-ink">
      <div className="relative flex w-full max-w-sm flex-col items-center text-center">
        <span className="mb-8 flex items-center gap-2.5 text-ink">
          <Mark className="size-6" />
          <span className="font-medium font-mono text-[17px] tracking-tight">opencompany</span>
        </span>

        {deepLink ? (
          <>
            <DesktopReturnRedirect deepLink={deepLink} />
            <h1 className="font-mono text-lg tracking-tight">Returning to the app…</h1>
            <p className="mt-3 text-sm text-ink-muted">
              You can close this tab. This browser was not signed in — only the opencompany app was.
            </p>
            <a
              href={deepLink}
              className="mt-6 inline-flex items-center justify-center rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500"
            >
              Open opencompany
            </a>
          </>
        ) : (
          <>
            <h1 className="font-mono text-lg tracking-tight">This link is incomplete</h1>
            <p className="mt-3 text-sm text-ink-muted">
              Start sign-in again from the opencompany app.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
