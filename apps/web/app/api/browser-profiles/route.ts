import {
  legacyCreateBrowserProfile,
  legacyListBrowserProfiles,
} from "@/lib/browser-profile-route-adapter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Temporary rollback/cached-client bridge; the canonical API owns browser
// profiles. Removal signal: the #1203 compatibility observation-window closure.
export async function GET(request: Request) {
  return legacyListBrowserProfiles(request);
}

export async function POST(request: Request) {
  return legacyCreateBrowserProfile(request);
}
