import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Compat redirect for bookmarked/cached links to the old hosted-AuthKit entry
// point. The real sign-in page now lives at /signin.
export function GET(request: NextRequest) {
  const url = new URL("/signin", request.url);
  url.search = request.nextUrl.search;
  return NextResponse.redirect(url);
}
