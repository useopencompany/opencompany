import { createLogger } from "@opencompany/observability";
import { NextResponse } from "next/server";
import { getWhatsAppProvider } from "@/lib/messaging/config";
import { handleInboundWhatsApp } from "@/lib/messaging/ingest";

// node:crypto (HMAC signature verification) + raw-body access require the Node runtime.
export const runtime = "nodejs";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

// Meta's webhook-subscription handshake: echo back hub.challenge when the verify token matches.
export async function GET(request: Request) {
  const provider = getWhatsAppProvider();
  if (!provider) {
    return new NextResponse("Not configured", { status: 503 });
  }
  const params = new URL(request.url).searchParams;
  const result = provider.verifyChallenge(params);
  if (!result.ok) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  // The challenge MUST be returned as plain text, not JSON.
  return new NextResponse(result.challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function POST(request: Request) {
  const provider = getWhatsAppProvider();
  // Ack with 200 even when unconfigured so Meta doesn't enter a retry storm against a dormant
  // deployment. Nothing is processed.
  if (!provider) {
    return NextResponse.json({ received: true });
  }

  // Verify against the EXACT received bytes — re-serializing would break the HMAC.
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!provider.verifySignature(rawBody, signature)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new NextResponse("Invalid JSON", { status: 400 });
  }

  const messages = provider.parseInbound(body);

  // Process sequentially (per-sender ordering is preserved) and isolate failures so one bad message
  // can't fail the whole batch — Meta would otherwise redeliver every message in the POST.
  for (const message of messages) {
    try {
      await handleInboundWhatsApp(provider, message);
    } catch (error) {
      logger.error("WhatsApp inbound handling failed", {
        event: "opencompany.whatsapp_inbound_failed",
        provider_message_id: message.providerMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Always 200: we've durably claimed each message (dedupe) and own retries internally.
  return NextResponse.json({ received: true });
}
