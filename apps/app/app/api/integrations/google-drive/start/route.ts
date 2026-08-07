import { handleGoogleOAuthStart } from "@/lib/integrations/google-routes";

export async function GET(request: Request) {
  return handleGoogleOAuthStart("google_drive", request);
}
