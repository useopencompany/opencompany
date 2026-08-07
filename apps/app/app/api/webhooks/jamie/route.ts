import { loadJamieWebhookContextForApiKey } from "@/lib/integrations/jamie";
import { JAMIE_WEBHOOK_SECRET_HEADER } from "@/lib/integrations/jamie-constants";
import { handleJamieWebhookDelivery } from "@/lib/integrations/jamie-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const webhookContext = await loadJamieWebhookContextForApiKey(
    request.headers.get(JAMIE_WEBHOOK_SECRET_HEADER),
  );
  return handleJamieWebhookDelivery({
    request,
    webhookContext,
    missingContextStatus: 401,
  });
}
