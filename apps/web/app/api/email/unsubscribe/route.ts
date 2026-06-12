import { captureException } from "@opencompany/observability";
import { unsubscribeResendContact, verifyEmailUnsubscribeToken } from "@/lib/email/unsubscribe";

export const dynamic = "force-dynamic";

function htmlResponse(body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><title>Unsubscribe</title><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body style="font-family:system-ui,sans-serif;margin:48px;line-height:1.5;color:#111">${body}</body></html>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function tokenFromRequest(request: Request) {
  return new URL(request.url).searchParams.get("token")?.trim() ?? "";
}

export async function GET(request: Request) {
  const token = tokenFromRequest(request);

  try {
    const result = await unsubscribeResendContact({ token });
    return htmlResponse(
      `<main><h1 style="font-size:20px;margin:0 0 12px">You're unsubscribed</h1><p style="margin:0">We won't send signup welcome emails to ${escapeHtml(result.email)}.</p></main>`,
    );
  } catch (error) {
    captureException(error, { event: "opencompany.email_unsubscribe_failed", method: "GET" });
    return htmlResponse(
      '<main><h1 style="font-size:20px;margin:0 0 12px">This unsubscribe link is invalid</h1><p style="margin:0">Reply to the email and we can help.</p></main>',
      400,
    );
  }
}

export async function POST(request: Request) {
  const token = tokenFromRequest(request);

  try {
    verifyEmailUnsubscribeToken(token);
    await unsubscribeResendContact({ token });
    return new Response(null, { status: 200 });
  } catch (error) {
    captureException(error, { event: "opencompany.email_unsubscribe_failed", method: "POST" });
    return new Response(null, { status: 400 });
  }
}
