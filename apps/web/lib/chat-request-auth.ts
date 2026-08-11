import { currentGoatUser, type GoatAuthContext } from "@/lib/auth";

export type GoatChatRequestContext = Pick<
  GoatAuthContext,
  "user" | "workspace" | "role" | "workspaces" | "brains" | "activeBrain"
>;

type ChatAuthResult =
  | { ok: true; context: GoatChatRequestContext }
  | { ok: false; response: Response };

// The legacy /api/chat route is a bounded browser rollback boundary for
// NEXT_PUBLIC_GOAT_HEADLESS_CHAT; it only ever authenticates the browser session cookie.
export async function resolveGoatChatRequestContext(_request: Request): Promise<ChatAuthResult> {
  const context = await currentGoatUser({ optional: true });
  return context
    ? { ok: true, context }
    : { ok: false, response: unauthorizedResponse("Unauthorized") };
}

function unauthorizedResponse(message: string) {
  return new Response(message, { status: 401 });
}
