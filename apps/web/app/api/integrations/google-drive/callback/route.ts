import { handleGoatGoogleOAuthCallback } from "@/lib/integrations/google-routes";

export async function GET(request: Request) {
  return handleGoatGoogleOAuthCallback("google_drive", request);
}
