import { getDb } from "@opencompany/db/client";
import { goatChatSessions } from "@opencompany/db/goat-schema";
import { getGoatBrainAccess } from "@opencompany/db/goat-workspaces";
import { and, eq, isNull } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";
import {
  buildGoatElectricOriginUrl,
  goatElectricBaseUrl,
  goatElectricBrainRef,
  goatElectricChatMessagesSessionId,
  goatElectricCodexChatSessionId,
  goatElectricLocalCodexChatSessionId,
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
  const authorizedChatSessionId = await authorizeChatSessionShape({
    requestUrl,
    userWorkosId: context.user.workosUserId,
  });
  const authorizedBrainRef = await authorizeBrainShape({
    requestUrl,
    userWorkosId: context.user.workosUserId,
  });

  const originUrl = buildGoatElectricOriginUrl({
    electricUrl,
    requestUrl,
    userWorkosId: context.user.workosUserId,
    workspaceId: context.workspace.id,
    authorizedChatSessionId,
    authorizedBrainRef,
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

async function authorizeChatSessionShape(input: {
  requestUrl: URL;
  userWorkosId: string;
}): Promise<string | null> {
  const sessionId =
    goatElectricChatMessagesSessionId(input.requestUrl) ??
    goatElectricLocalCodexChatSessionId(input.requestUrl) ??
    goatElectricCodexChatSessionId(input.requestUrl);
  if (!sessionId) return null;

  const [session] = await getDb()
    .select({ id: goatChatSessions.id })
    .from(goatChatSessions)
    .where(
      and(
        eq(goatChatSessions.id, sessionId),
        eq(goatChatSessions.userWorkosId, input.userWorkosId),
        isNull(goatChatSessions.closedAt),
      ),
    )
    .limit(1);

  return session?.id ?? null;
}

async function authorizeBrainShape(input: {
  requestUrl: URL;
  userWorkosId: string;
}): Promise<string | null> {
  const brainRef = goatElectricBrainRef(input.requestUrl);
  if (!brainRef) return null;

  const access = await getGoatBrainAccess({
    userWorkosId: input.userWorkosId,
    brainRef,
  });
  return access?.brain.id ?? null;
}
