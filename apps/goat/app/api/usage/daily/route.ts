import { currentGoatUser } from "@/lib/auth";
import { getGoatDailyUsage, getGoatUsageDrilldown } from "@/lib/gateway-usage";

export const runtime = "nodejs";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_USAGE_DAYS = 31;

export async function GET(request: Request): Promise<Response> {
  const context = await currentGoatUser({ optional: true });
  if (!context) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
  if (!apiKey) {
    return Response.json({ error: "Goat usage reporting is not configured." }, { status: 503 });
  }

  const url = new URL(request.url);
  const start = url.searchParams.get("start")?.trim() ?? "";
  const end = url.searchParams.get("end")?.trim() ?? "";
  const drilldownDay = url.searchParams.get("day")?.trim() ?? "";
  const validation = validateDateRange(start, end);
  if (validation) return Response.json({ error: validation }, { status: 400 });
  if (drilldownDay && !isValidUtcDate(drilldownDay)) {
    return Response.json(
      { error: "`day` must be a valid UTC date in YYYY-MM-DD format." },
      { status: 400 },
    );
  }

  try {
    const [days, drilldown] = await Promise.all([
      getGoatDailyUsage({
        apiKey,
        userWorkosId: context.user.workosUserId,
        start,
        end,
      }),
      drilldownDay
        ? getGoatUsageDrilldown({
            apiKey,
            userWorkosId: context.user.workosUserId,
            day: drilldownDay,
          })
        : Promise.resolve(null),
    ]);

    return Response.json({
      timezone: "UTC",
      start,
      end,
      days,
      ...(drilldown ? { drilldown: { day: drilldownDay, items: drilldown } } : {}),
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Could not load Goat usage from AI Gateway.",
      },
      { status: 502 },
    );
  }
}

function validateDateRange(start: string, end: string) {
  if (!isValidUtcDate(start) || !isValidUtcDate(end)) {
    return "`start` and `end` must be valid UTC dates in YYYY-MM-DD format.";
  }
  const startDate = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(`${end}T00:00:00.000Z`);
  if (startDate > endDate) return "`start` must be before or equal to `end`.";
  const days = (endDate.getTime() - startDate.getTime()) / 86_400_000 + 1;
  if (days > MAX_USAGE_DAYS) return `Date range cannot exceed ${MAX_USAGE_DAYS} days.`;
  return null;
}

function isValidUtcDate(value: string) {
  if (!ISO_DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
