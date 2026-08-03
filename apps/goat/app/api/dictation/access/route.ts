import { NextResponse } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { requestGoatDictationAccess } from "@/lib/task-runner";

export const runtime = "nodejs";

export async function POST() {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });

  try {
    return NextResponse.json(
      await requestGoatDictationAccess({ userWorkosId: context.user.workosUserId }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dictation is unavailable.";
    return new Response(message, { status: 502 });
  }
}
