import { analyzeAdaptiveToolQuery } from "@/experiments/adaptive-tool-exposure/activation";
import { runAdaptiveToolAgent } from "@/experiments/adaptive-tool-exposure/runtime";
import type { AdaptiveExperimentResponse } from "@/experiments/adaptive-tool-exposure/types";
import { currentGoatUser } from "@/lib/auth";
import { GOAT_MODELS } from "@/lib/model-options";

export const runtime = "nodejs";
export const maxDuration = 90;

const MAX_QUERY_LENGTH = 2_000;
const ALLOWED_MODELS = new Set(GOAT_MODELS.map((model) => model.id));

type RequestBody = {
  query?: unknown;
  mode?: unknown;
  model?: unknown;
};

export async function POST(request: Request): Promise<Response> {
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test") {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  if (process.env.NODE_ENV === "test") {
    const context = await currentGoatUser({ optional: true });
    if (!context) return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await readBody(request);
  if (!body.ok) return Response.json({ error: body.error }, { status: 400 });
  const query = typeof body.value.query === "string" ? body.value.query.trim() : "";
  if (!query) return Response.json({ error: "Enter a query to analyze." }, { status: 400 });
  if (query.length > MAX_QUERY_LENGTH) {
    return Response.json(
      { error: `Query cannot exceed ${MAX_QUERY_LENGTH.toLocaleString()} characters.` },
      { status: 400 },
    );
  }

  const mode = body.value.mode === "agent" ? "agent" : "analyze";
  if (mode === "analyze") {
    const response: AdaptiveExperimentResponse = {
      mode,
      snapshot: analyzeAdaptiveToolQuery(query),
    };
    return Response.json(response);
  }

  const model = typeof body.value.model === "string" ? body.value.model : "";
  if (!ALLOWED_MODELS.has(model as (typeof GOAT_MODELS)[number]["id"])) {
    return Response.json({ error: "Choose a supported Goat model." }, { status: 400 });
  }
  const gatewayApiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
  if (!gatewayApiKey) {
    return Response.json({ error: "Vercel AI Gateway is not configured." }, { status: 503 });
  }

  try {
    const result = await runAdaptiveToolAgent({ query, model, gatewayApiKey });
    const response: AdaptiveExperimentResponse = { mode, ...result };
    return Response.json(response);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The simulated agent run failed." },
      { status: 502 },
    );
  }
}

async function readBody(
  request: Request,
): Promise<{ ok: true; value: RequestBody } | { ok: false; error: string }> {
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Request body must be a JSON object." };
    }
    return { ok: true, value: value as RequestBody };
  } catch {
    return { ok: false, error: "Request body must be valid JSON." };
  }
}
