import { handleGoatGoogleOAuthStart } from "@/lib/integrations/google-routes";

export async function GET(request: Request) {
  return handleGoatGoogleOAuthStart("google_calendar", request);
}
