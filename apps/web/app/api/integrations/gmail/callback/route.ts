import { handleGoogleOAuthCallback } from "@/lib/integrations/google-routes";

export async function GET(request: Request) {
  return handleGoogleOAuthCallback("gmail", request);
}
