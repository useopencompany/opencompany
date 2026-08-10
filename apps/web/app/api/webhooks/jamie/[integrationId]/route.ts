import { loadGoatJamieWebhookContext } from "@/lib/integrations/jamie";
import { handleGoatJamieWebhookDelivery } from "@/lib/integrations/jamie-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ integrationId: string }> },
) {
  const { integrationId } = await context.params;
  const webhookContext = await loadGoatJamieWebhookContext(integrationId);
  return handleGoatJamieWebhookDelivery({
    request,
    webhookContext,
    missingContextStatus: 404,
  });
}
