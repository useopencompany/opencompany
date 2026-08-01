import { track } from "@vercel/analytics/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const WORKOS_URL = new URL("https://workos.com/");
WORKOS_URL.searchParams.set("utm_source", "opencompany");
WORKOS_URL.searchParams.set("utm_medium", "partner");
WORKOS_URL.searchParams.set("utm_campaign", "workos-partnership");

export async function GET(request: NextRequest) {
  const placement = request.nextUrl.searchParams.get("placement")?.slice(0, 100) || "direct";

  try {
    await track(
      "Partner referral",
      {
        partner: "workos",
        placement,
      },
      { request: { headers: request.headers } },
    );
  } catch (error) {
    console.error("[workos redirect] analytics failed", error);
  }

  const response = NextResponse.redirect(WORKOS_URL, 307);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
