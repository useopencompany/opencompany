import { loadGoatJamieWebhookContextForApiKey } from "@/lib/integrations/jamie";
import { GOAT_JAMIE_WEBHOOK_SECRET_HEADER } from "@/lib/integrations/jamie-constants";
import { handleGoatJamieWebhookDelivery } from "@/lib/integrations/jamie-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const webhookContext = await loadGoatJamieWebhookContextForApiKey(
    request.headers.get(GOAT_JAMIE_WEBHOOK_SECRET_HEADER),
  );
  return handleGoatJamieWebhookDelivery({
    request,
    webhookContext,
    missingContextStatus: 401,
  });
}
