import { isValidBrainId } from "@opencompany/brain";
import { createApiClient, type ErrorEnvelope } from "@opencompany/protocol";

// Temporary compatibility adapter for the pre-/v1 browser URL. The first-party web client no
// longer calls this route; retain it through the Workflow cutover rollback window, then delete it.
export async function GET(request: Request) {
  const connection = compatibilityClient(request);
  if (!connection) return unavailable();

  const workflows: Array<{ id: string; name: string; description: string }> = [];
  let cursor: string | undefined;
  do {
    const response = await connection.client.v1.workflows.$get({
      query: { limit: "100", ...(cursor ? { cursor } : {}) },
    });
    if (!response.ok) {
      return compatibilityError(
        response,
        "Workflow catalog request failed.",
        connection.responseHeaders,
      );
    }
    const page = await response.json();
    for (const workflow of page.data) {
      if (
        workflow.status === "active" &&
        workflow.steps.length > 0 &&
        workflow.steps.every((step: { instructions: string }) => step.instructions.trim())
      ) {
        workflows.push({
          id: workflow.slug,
          name: workflow.name,
          description: workflow.description,
        });
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return Response.json({ workflows }, { headers: connection.responseHeaders });
}

export async function POST(request: Request) {
  const connection = compatibilityClient(request);
  if (!connection) return unavailable();
  const body = await request.json().catch(() => null);
  if (
    !isRecord(body) ||
    !isRecord(body.workflow) ||
    typeof body.workflow.id !== "string" ||
    !isValidBrainId(body.workflow.id)
  ) {
    return Response.json({ error: "A workflow is required." }, { status: 400 });
  }
  if (typeof body.description !== "string" || !body.description.trim()) {
    return Response.json({ error: "A workflow task description is required." }, { status: 400 });
  }
  const mentions = Array.isArray(body.mentions) ? body.mentions : [];
  if (
    mentions.some(
      (mention) =>
        isRecord(mention) &&
        mention.kind === "skill" &&
        (typeof mention.id !== "string" || !isValidBrainId(mention.id)),
    )
  ) {
    return Response.json({ error: "Invalid skill mention." }, { status: 400 });
  }
  const skillIds = mentions.flatMap((mention) =>
    isRecord(mention) &&
    mention.kind === "skill" &&
    typeof mention.id === "string" &&
    isValidBrainId(mention.id)
      ? [mention.id]
      : [],
  );
  const attachmentIds = Array.isArray(body.attachments)
    ? body.attachments.flatMap((attachment) =>
        isRecord(attachment) && typeof attachment.id === "string" ? [attachment.id] : [],
      )
    : [];
  const response = await connection.client.v1.workflows[":workflowId"].invoke.$post({
    param: { workflowId: body.workflow.id },
    header: { "idempotency-key": `web-workflow-compat:${crypto.randomUUID()}` },
    json: {
      description: body.description,
      ...(skillIds.length ? { skillIds } : {}),
      ...(attachmentIds.length ? { attachmentIds } : {}),
    },
  });
  if (!response.ok) {
    return compatibilityError(
      response,
      "Could not start that workflow task.",
      connection.responseHeaders,
    );
  }
  const result = (await response.json()).data;
  return Response.json(
    {
      task: {
        id: result.task.id,
        displayId: result.task.displayId,
        name: result.task.name,
      },
    },
    { status: 201, headers: connection.responseHeaders },
  );
}

function compatibilityClient(request: Request) {
  const origin = configuredApiOrigin(process.env.GOAT_API_ORIGIN);
  if (!origin) return null;
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  const browserOrigin = request.headers.get("origin");
  const responseHeaders = new Headers({ "Cache-Control": "private, no-store" });
  const fetchWithActor: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (cookie) headers.set("Cookie", cookie);
    if (authorization) headers.set("Authorization", authorization);
    if (browserOrigin) headers.set("Origin", browserOrigin);
    const response = await globalThis.fetch(input, { ...init, headers, cache: "no-store" });
    const refreshedCookie = response.headers.get("set-cookie");
    if (refreshedCookie) responseHeaders.set("Set-Cookie", refreshedCookie);
    return response;
  };
  return { client: createApiClient(origin, { fetch: fetchWithActor }), responseHeaders };
}

function configuredApiOrigin(value: string | undefined) {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

async function compatibilityError(response: Response, fallback: string, headers: Headers) {
  const body = (await response.json().catch(() => null)) as ErrorEnvelope | null;
  return Response.json(
    { error: body?.error.message ?? fallback },
    { status: response.status, headers },
  );
}

function unavailable() {
  return Response.json({ error: "The Workflow API is unavailable." }, { status: 503 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
