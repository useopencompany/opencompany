const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Maps the form's `source` to the label recorded in HubSpot. Add an entry here
// whenever a new page grows an EmailCaptureForm.
const PAGE_NAMES: Record<string, string> = {
  ship: "Ship early access",
  benchmarks: "Benchmarks ranking alerts",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Forwards to HubSpot's public Forms submission endpoint — no secret required,
// just the portal + form IDs from the HubSpot form for this launch. Set
// HUBSPOT_PORTAL_ID and HUBSPOT_SHIP_FORM_GUID once that form exists; until
// then this route accepts submissions and just logs them.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const source = typeof body?.source === "string" ? body.source : "unknown";

  if (!EMAIL_RE.test(email)) {
    return jsonResponse({ error: "Enter a valid email address." }, 400);
  }

  const portalId = process.env.HUBSPOT_PORTAL_ID;
  const formGuid = process.env.HUBSPOT_SHIP_FORM_GUID;

  if (!portalId || !formGuid) {
    console.warn(`[early-access] HubSpot not configured, logging lead: ${email} (${source})`);
    return jsonResponse({ ok: true }, 200);
  }

  const hubspotResponse = await fetch(
    `https://api.hsforms.com/submissions/v3/integration/submit/${portalId}/${formGuid}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: [{ name: "email", value: email }],
        context: {
          pageUri: request.headers.get("referer") ?? undefined,
          pageName: PAGE_NAMES[source] ?? "Early access",
        },
      }),
    },
  );

  if (!hubspotResponse.ok) {
    console.error("[early-access] HubSpot submission failed", await hubspotResponse.text());
    return jsonResponse({ error: "Something went wrong. Try again." }, 502);
  }

  return jsonResponse({ ok: true }, 200);
}
