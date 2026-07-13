import { reconcileGoatWorkspaceSeatQuantities } from "@/lib/billing/seat-sync";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const results = await reconcileGoatWorkspaceSeatQuantities();
  const failed = results.filter((result) => !result.ok).length;
  return Response.json(
    {
      checked: results.length,
      failed,
    },
    { status: failed > 0 ? 502 : 200 },
  );
}
