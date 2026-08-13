import { currentGoatUser } from "@/lib/auth";
import {
  buildGoatElectricOriginUrl,
  goatElectricBaseUrl,
  hasInvalidElectricCloudSecretPair,
} from "@/lib/electric";

export async function GET(request: Request): Promise<Response> {
  const electricUrl = goatElectricBaseUrl();
  if (!electricUrl) {
    return new Response("Electric sync is not configured.", { status: 503 });
  }

  const context = await currentGoatUser({ optional: true });
  if (!context) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sourceId = process.env.ELECTRIC_SOURCE_ID?.trim();
  const sourceSecret = process.env.ELECTRIC_SOURCE_SECRET?.trim();
  const electricSecret = process.env.ELECTRIC_SECRET?.trim();
  if (hasInvalidElectricCloudSecretPair({ sourceId, sourceSecret })) {
    return new Response("Electric sync is misconfigured.", { status: 503 });
  }

  const requestUrl = new URL(request.url);
  const originUrl = buildGoatElectricOriginUrl({
    electricUrl,
    requestUrl,
    userWorkosId: context.user.workosUserId,
    workspaceId: context.workspace.id,
    sourceId,
    sourceSecret,
    electricSecret,
  });
  if (!originUrl) {
    return new Response("Unknown or unauthorized shape.", { status: 403 });
  }

  const usesQuerySecret = Boolean((sourceId && sourceSecret) || electricSecret);
  const response = await fetch(originUrl, {
    headers:
      !usesQuerySecret && process.env.ELECTRIC_TOKEN
        ? { Authorization: `Bearer ${process.env.ELECTRIC_TOKEN}` }
        : {},
  });

  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("Vary", "Cookie");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
