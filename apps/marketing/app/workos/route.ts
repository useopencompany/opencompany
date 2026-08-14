import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const WORKOS_URL = new URL("https://workos.com/");
WORKOS_URL.searchParams.set("utm_source", "opencompany");
WORKOS_URL.searchParams.set("utm_medium", "partner");
WORKOS_URL.searchParams.set("utm_campaign", "workos-partnership");

export function GET() {
  const response = NextResponse.redirect(WORKOS_URL, 307);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
