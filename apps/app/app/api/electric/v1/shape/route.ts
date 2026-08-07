import { getDb } from "@opencompany/db/client";
import { chatSessions, codexChatSessions } from "@opencompany/db/schema";
import { getBrainAccess } from "@opencompany/db/workspaces";
import { and, eq, isNull, or } from "drizzle-orm";
import { currentUser } from "@/lib/auth";
import {
  buildElectricOriginUrl,
  electricBaseUrl,
  electricBrainRef,
  electricChatMessagesSessionId,
  electricCodexChatSessionId,
  hasInvalidElectricCloudSecretPair,
} from "@/lib/electric";

export async function GET(request: Request): Promise<Response> {
  const electricUrl = electricBaseUrl();
  if (!electricUrl) {
    return new Response("Electric sync is not configured.", { status: 503 });
  }

  const context = await currentUser({ optional: true });
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
    workspaceId: context.workspace.id,
  });
  const authorizedBrainRef = await authorizeBrainShape({
    requestUrl,
    userWorkosId: context.user.workosUserId,
  });

  const originUrl = buildElectricOriginUrl({
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

export async function authorizeChatSessionShape(input: {
  requestUrl: URL;
  userWorkosId: string;
  workspaceId: string;
}): Promise<string | null> {
  const sessionId =
    electricChatMessagesSessionId(input.requestUrl) ?? electricCodexChatSessionId(input.requestUrl);
  if (!sessionId) return null;

  const [session] = await getDb()
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .leftJoin(
      codexChatSessions,
      and(
        eq(codexChatSessions.chatSessionId, chatSessions.id),
        eq(codexChatSessions.userWorkosId, chatSessions.userWorkosId),
      ),
    )
    .where(
      and(
        eq(chatSessions.id, sessionId),
        isNull(chatSessions.closedAt),
        or(
          and(eq(chatSessions.kind, "chat"), eq(chatSessions.userWorkosId, input.userWorkosId)),
          and(eq(chatSessions.kind, "task"), eq(codexChatSessions.workspaceId, input.workspaceId)),
        ),
      ),
    )
    .limit(1);

  return session?.id ?? null;
}

async function authorizeBrainShape(input: {
  requestUrl: URL;
  userWorkosId: string;
}): Promise<string | null> {
  const brainRef = electricBrainRef(input.requestUrl);
  if (!brainRef) return null;

  const access = await getBrainAccess({
    userWorkosId: input.userWorkosId,
    brainRef,
  });
  return access?.brain.id ?? null;
}
