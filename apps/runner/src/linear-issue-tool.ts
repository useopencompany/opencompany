import { agentSessionMessageAttachments } from "@opencompany/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { downloadBlobBytes } from "./attachment-hydration";
import { getDb } from "./db";
import { connectWorkspaceMcpClient, type WorkspaceMcpToolClient } from "./mcp-tools";

// create_linear_issue (kind: "internal") runs in the runner, not the sandbox. It creates an issue
// in the workspace's OWN connected Linear by driving that workspace's Linear MCP connection (the
// same decrypted OAuth credential the agent's `linear__use_tool` uses) — NOT OpenCompany's internal
// LINEAR_API_KEY feedback Linear.
//
// Step A: create a text issue (team resolution). Step B: attach the image(s) the user dropped into
// THIS session — read their bytes server-side from the private Vercel Blob and push them to Linear
// (prepare_attachment_upload -> PUT bytes -> create_attachment_from_upload). The agent never needs a
// "file": it only sees the image as base64 in its context; the runner moves the real bytes.

type RecoverableResult = {
  ok: false;
  error: { message: string; code: string; recoverable: boolean };
};

function recoverable(code: string, message: string): RecoverableResult {
  return { ok: false, error: { message, code, recoverable: true } };
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// MCP tool results arrive as content blocks ({ content: [{ type: "text", text }] }) or, depending on
// SDK normalization, as arrays/strings/objects. Flatten to text for the model + for parsing.
function mcpResultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map(mcpResultText).filter(Boolean).join("\n");
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.content)) return mcpResultText(obj.content);
    if (typeof obj.text === "string") return obj.text;
    return JSON.stringify(obj);
  }
  return String(result);
}

// Pull the structured JSON object out of an MCP tool result (handles both the content-wrapped form
// and an already-parsed object). Returns null if nothing parseable.
function parseMcpJson(result: unknown): Record<string, unknown> | null {
  if (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    !("content" in (result as Record<string, unknown>))
  ) {
    return result as Record<string, unknown>;
  }
  const text = mcpResultText(result).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type LinearTeam = { id?: string; key?: string; name?: string };

// Best-effort: the Linear MCP returns team data as text (often JSON). Parse what we can; an empty
// result just means we fall back to asking the model/user to name the team.
function parseTeams(result: unknown): LinearTeam[] {
  const text = mcpResultText(result).trim();
  if (!text) return [];
  const collect = (value: unknown): LinearTeam[] => {
    if (Array.isArray(value)) {
      return value.filter((t): t is LinearTeam => Boolean(t) && typeof t === "object");
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      for (const key of ["teams", "nodes", "data", "items"]) {
        if (Array.isArray(obj[key])) return collect(obj[key]);
      }
    }
    return [];
  };
  try {
    return collect(JSON.parse(text));
  } catch {
    return [];
  }
}

async function fetchTeams(linear: WorkspaceMcpToolClient): Promise<LinearTeam[]> {
  try {
    return parseTeams(await linear.callTool("list_teams", { limit: 50 }));
  } catch {
    return [];
  }
}

function teamLabel(team: LinearTeam): string | undefined {
  return team.key || team.name || team.id || undefined;
}

type SessionImage = { filename: string; mediaType: string; blobUrl: string };

// The image attachment(s) the user dropped onto their most recent message in THIS session. Scoped to
// session + workspace server-side — the model never supplies a blob source. Grouping by the newest
// messageId means we attach exactly the just-dropped screenshot(s), not older images in the session.
async function fetchLatestSessionImages(
  sessionId: string,
  workspaceId: string,
): Promise<SessionImage[]> {
  const rows = await getDb()
    .select({
      messageId: agentSessionMessageAttachments.messageId,
      filename: agentSessionMessageAttachments.filename,
      mediaType: agentSessionMessageAttachments.mediaType,
      blobUrl: agentSessionMessageAttachments.blobUrl,
      createdAt: agentSessionMessageAttachments.createdAt,
    })
    .from(agentSessionMessageAttachments)
    .where(
      and(
        eq(agentSessionMessageAttachments.sessionId, sessionId),
        eq(agentSessionMessageAttachments.workspaceId, workspaceId),
        eq(agentSessionMessageAttachments.kind, "image"),
      ),
    )
    .orderBy(desc(agentSessionMessageAttachments.createdAt));
  const newestMessageId = rows[0]?.messageId;
  if (!newestMessageId) return [];
  return rows
    .filter((r) => r.messageId === newestMessageId)
    .map((r) => ({ filename: r.filename, mediaType: r.mediaType, blobUrl: r.blobUrl }));
}

// Upload one image's bytes to Linear and attach it to the issue. Throws on any failure (caller
// treats a failed image as non-fatal). The signed upload URL expires in 60s, so prepare -> PUT runs
// back-to-back; images are processed one at a time (Linear requires it).
async function attachImageToIssue(
  linear: WorkspaceMcpToolClient,
  issue: string,
  image: SessionImage,
  blobToken: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const bytes = await downloadBlobBytes(image.blobUrl, blobToken);
  const prep = parseMcpJson(
    await linear.callTool("prepare_attachment_upload", {
      issue,
      filename: image.filename,
      contentType: image.mediaType,
      size: bytes.byteLength,
    }),
  );
  const uploadRequest = prep?.uploadRequest as
    | { url?: string; method?: string; headers?: Record<string, string> }
    | undefined;
  const assetUrl = typeof prep?.assetUrl === "string" ? prep.assetUrl : undefined;
  if (!uploadRequest?.url || !assetUrl) {
    throw new Error("prepare_attachment_upload returned no upload URL / assetUrl");
  }
  const put = await fetch(uploadRequest.url, {
    method: uploadRequest.method ?? "PUT",
    headers: uploadRequest.headers ?? { "content-type": image.mediaType },
    // Buffer isn't a valid fetch BodyInit per the DOM types; copy into an ArrayBuffer-backed view.
    body: new Uint8Array(bytes),
    signal,
  });
  if (!put.ok) {
    throw new Error(`attachment upload PUT failed: ${put.status} ${put.statusText}`);
  }
  await linear.callTool("create_attachment_from_upload", {
    issue,
    assetUrl,
    title: image.filename,
  });
}

export async function runCreateLinearIssueTool(input: {
  sessionId: string;
  workspaceId: string;
  args: unknown;
  integrationCredentialEncryptionKey: Buffer;
  blobReadWriteToken: string | undefined;
  signal: AbortSignal;
}): Promise<unknown> {
  const args = (input.args ?? {}) as Record<string, unknown>;
  const title = typeof args.title === "string" ? args.title.trim() : "";
  const description = typeof args.description === "string" ? args.description : "";
  const teamArg = typeof args.team === "string" ? args.team.trim() : "";
  const includeAttachments = args.include_attachments !== false; // default true
  if (!title) {
    return recoverable("invalid_tool_input", "create_linear_issue requires a non-empty `title`.");
  }

  let linear: WorkspaceMcpToolClient;
  try {
    linear = await connectWorkspaceMcpClient({
      workspaceId: input.workspaceId,
      provider: "linear",
      integrationCredentialEncryptionKey: input.integrationCredentialEncryptionKey,
      signal: input.signal,
    });
  } catch (error) {
    return recoverable(
      "linear_not_connected",
      `This workspace's Linear isn't connected (or the connection failed): ${errMessage(error)}. Ask the user to connect Linear in Settings → Integrations, then try again.`,
    );
  }

  try {
    let team = teamArg;
    if (!team) {
      const teams = await fetchTeams(linear);
      if (teams.length === 1) {
        team = teamLabel(teams[0]!) ?? "";
      } else {
        const labels = teams.map(teamLabel).filter((v): v is string => Boolean(v));
        return recoverable(
          "linear_team_required",
          labels.length
            ? `Which Linear team should this go in? Options: ${labels.join(", ")}. Re-call create_linear_issue with \`team\` set to one of these.`
            : "A Linear team is required to create the issue. Re-call create_linear_issue with `team` set to a team name or key from the user's Linear.",
        );
      }
    }

    const issueArgs: Record<string, unknown> = { title, team };
    if (description) issueArgs.description = description;

    const createResult = await linear.callTool("save_issue", issueArgs);
    const created = parseMcpJson(createResult);
    const issueId = typeof created?.id === "string" ? created.id : undefined;
    const issueUrl = typeof created?.url === "string" ? created.url : undefined;

    // Step B: attach the dropped screenshot(s). Best-effort — a failed image must not fail the
    // issue (mirrors the feedback flow's resilience). Needs the issue id from save_issue.
    let attachedImages = 0;
    let failedImages = 0;
    if (includeAttachments && issueId) {
      const images = await fetchLatestSessionImages(input.sessionId, input.workspaceId);
      for (const image of images) {
        try {
          await attachImageToIssue(linear, issueId, image, input.blobReadWriteToken, input.signal);
          attachedImages += 1;
        } catch {
          failedImages += 1;
        }
      }
    }

    return {
      ok: true,
      team,
      issue: { id: issueId, url: issueUrl, raw: mcpResultText(createResult).slice(0, 2000) },
      attachedImages,
      failedImages,
      message:
        `Created a Linear issue in team "${team}".` +
        (attachedImages ? ` Attached ${attachedImages} image(s).` : "") +
        (failedImages ? ` ${failedImages} image(s) could not be attached.` : ""),
    };
  } catch (error) {
    return recoverable(
      "linear_issue_create_failed",
      `Could not create the Linear issue: ${errMessage(error)}`,
    );
  } finally {
    await linear.close().catch(() => {});
  }
}
