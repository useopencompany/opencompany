import { loadJamieWebhookContext } from "@/lib/integrations/jamie";
import { handleJamieWebhookDelivery } from "@/lib/integrations/jamie-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ integrationId: string }> },
) {
  const { integrationId } = await context.params;
  const webhookContext = await loadJamieWebhookContext(integrationId);
  return handleJamieWebhookDelivery({
    request,
    webhookContext,
    missingContextStatus: 404,
  });
}
