"use server";

import {
  AGENT_SCHEDULE_TRIGGER_TYPE,
  FIXED_PERSONAL_AGENT_NAME,
  normalizeAgentConfig,
  serializeAgentFile,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { agents, userAvatars, users } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { hashAgentSource } from "@/lib/agents/hash";
import { AUTHENTICATION_REQUIRED_MESSAGE, currentWorkspace } from "@/lib/auth";
import { normalizeUserTimezone, type UserTimezoneSource } from "@/lib/timezones";

// Avatars are resized to ~256px webp on the client; this is a generous hard cap so a
// crafted request can't push large blobs into Postgres.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB

// Sniff the real image type from magic bytes instead of trusting the client-declared
// mime — a request can bypass the client resizer, so the stored mime (which the serve
// route echoes back as Content-Type) must be derived from the actual content.
function detectImageMime(buf: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export async function updateAvatar(input: { dataBase64: string }) {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  const buffer = Buffer.from(input.dataBase64, "base64");
  if (buffer.length === 0) {
    return { ok: false as const, error: "The image is empty." };
  }
  if (buffer.length > MAX_AVATAR_BYTES) {
    return { ok: false as const, error: "Image is too large (max 2 MB)." };
  }

  const mime = detectImageMime(buffer);
  if (!mime) {
    return { ok: false as const, error: "Unsupported image. Use PNG, JPEG, or WebP." };
  }

  const db = getDb();
  const now = new Date();
  try {
    await db
      .insert(userAvatars)
      .values({ userId: context.user.id, blob: buffer, mime, updatedAt: now })
      .onConflictDoUpdate({
        target: userAvatars.userId,
        set: { blob: buffer, mime, updatedAt: now },
      });
  } catch {
    return { ok: false as const, error: "Could not save the image. Please try again." };
  }

  revalidatePath("/", "layout");
  revalidatePath("/company/settings");
  return { ok: true as const };
}

// Per-user "Pro mode" toggle, set from personal Settings. Persisted on `users.proMode` so the
// /personal layout (and thus the sidebar) picks it up on the next load; the client also flips it
// optimistically via PersonalAgentContext so the Memory row appears/disappears without a reload.
export async function setProMode(next: boolean) {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  try {
    await getDb()
      .update(users)
      .set({ proMode: next, updatedAt: new Date() })
      .where(eq(users.id, context.user.id));
  } catch {
    return { ok: false as const, error: "Could not update Pro mode. Please try again." };
  }

  revalidatePath("/personal", "layout");
  return { ok: true as const };
}

// Per-user opt-in to the legacy company/workspace surface, set from personal Settings. Persisted
// on `users.companySurfaceEnabled` so the /personal layout picks it up on the next load; the
// client also flips it optimistically via PersonalAgentContext so the space switcher
// appears/disappears without a reload.
export async function setCompanySurfaceEnabled(next: boolean) {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  try {
    await getDb()
      .update(users)
      .set({ companySurfaceEnabled: next, updatedAt: new Date() })
      .where(eq(users.id, context.user.id));
  } catch {
    return { ok: false as const, error: "Could not update company access. Please try again." };
  }

  revalidatePath("/personal", "layout");
  return { ok: true as const };
}

// Per-user "Codex runtime" feature flag, set from Settings → Feature flags. Persisted on
// `users.codexEngineEnabled` so both surfaces pick it up on next load: the /personal layout (which
// flips it optimistically via PersonalAgentContext for the Settings toggle) and the /company agent
// editor (which reads it from WorkspaceContext to show/hide the engine selector). Revalidate both
// layouts so the agent editor's engine selector appears/disappears after the flag changes.
export async function setCodexEngineEnabled(next: boolean) {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  try {
    await getDb()
      .update(users)
      .set({ codexEngineEnabled: next, updatedAt: new Date() })
      .where(eq(users.id, context.user.id));
  } catch {
    return { ok: false as const, error: "Could not update the Codex runtime flag. Please try again." };
  }

  revalidatePath("/personal", "layout");
  revalidatePath("/company", "layout");
  return { ok: true as const };
}

export async function setUserTimezone(
  input: string | { timezone: string; source?: Exclude<UserTimezoneSource, "unset"> },
) {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  const rawTimezone = typeof input === "string" ? input : input.timezone;
  const timezone = normalizeUserTimezone(rawTimezone);
  if (!timezone) {
    return { ok: false as const, error: "Choose a valid timezone." };
  }
  const source: Exclude<UserTimezoneSource, "unset"> =
    typeof input === "string" ? "manual" : input.source === "browser" ? "browser" : "manual";
  const db = getDb();
  const now = new Date();
  let updatedConfig = null;

  try {
    await db
      .update(users)
      .set({ timezone, timezoneSource: source, updatedAt: now })
      .where(eq(users.id, context.user.id));

    const [agent] = await db
      .select({
        id: agents.id,
        body: agents.body,
        config: agents.config,
        version: agents.version,
      })
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, context.workspace.id),
          eq(agents.userId, context.user.id),
          eq(agents.isDefault, true),
        ),
      )
      .limit(1);

    if (agent) {
      const currentConfig = normalizeAgentConfig(agent.config);
      const nextConfig = {
        ...currentConfig,
        triggers: currentConfig.triggers.map((trigger) =>
          trigger.type === AGENT_SCHEDULE_TRIGGER_TYPE ? { ...trigger, timezone } : trigger,
        ),
      };
      const source = serializeAgentFile({
        title: FIXED_PERSONAL_AGENT_NAME,
        body: agent.body,
        model: nextConfig.model.name,
        tools: nextConfig.tools,
        brain: nextConfig.brain,
        agents: nextConfig.agents ?? [],
        skills: nextConfig.skills ?? [],
        integrations: nextConfig.integrations,
        triggers: nextConfig.triggers,
      });

      await db
        .update(agents)
        .set({
          config: nextConfig,
          contentHash: hashAgentSource(source),
          version: agent.version + 1,
          updatedAt: now,
        })
        .where(and(eq(agents.id, agent.id), eq(agents.workspaceId, context.workspace.id)));
      updatedConfig = nextConfig;
    }
  } catch {
    return { ok: false as const, error: "Could not update timezone. Please try again." };
  }

  revalidatePath("/personal", "layout");
  return { ok: true as const, timezone, source, config: updatedConfig };
}

export async function removeAvatar() {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  const db = getDb();
  try {
    await db.delete(userAvatars).where(eq(userAvatars.userId, context.user.id));
  } catch {
    return { ok: false as const, error: "Could not remove the image. Please try again." };
  }

  revalidatePath("/", "layout");
  revalidatePath("/company/settings");
  return { ok: true as const };
}
