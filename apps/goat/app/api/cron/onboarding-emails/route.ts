import { sweepDueOnboardingEmails } from "@/lib/email/onboarding-emails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hourly sweep for the founder onboarding drip. The welcome email is sent inline
// at signup; this backstops it and delivers the day-1 / day-5 steps once their
// scheduled_at falls due. Authenticated with the shared Vercel CRON_SECRET, same
// as /api/billing/reconcile.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await sweepDueOnboardingEmails({ limit: 100 });
  return Response.json(result);
}
