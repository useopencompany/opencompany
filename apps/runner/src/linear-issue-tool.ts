import { agentSessionMessageAttachments, agentSessionMessages } from "@opencompany/db/schema";
import { captureException } from "@opencompany/observability";
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

// The AI-SDK MCP client returns a FAILED tool call as a result object with isError:true — it does
// NOT throw. Detect that so save/attach failures become real errors instead of phantom successes.
function isMcpError(result: unknown): boolean {
  return Boolean(
    result && typeof result === "object" && (result as Record<string, unknown>).isError === true,
  );
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

// The image attachment(s) on the most recent USER message in this session — i.e. the message that
// triggered this turn. Scoped to that ONE message (not the globally-newest image in the session) so
// we attach the just-dropped screenshot and never re-attach a stale image from an earlier turn when
// the current message had none. Scoped server-side; the model never supplies a blob source.
async function fetchLatestSessionImages(
  sessionId: string,
  workspaceId: string,
): Promise<SessionImage[]> {
  const [latestUserMessage] = await getDb()
    .select({ id: agentSessionMessages.id })
    .from(agentSessionMessages)
    .where(
      and(eq(agentSessionMessages.sessionId, sessionId), eq(agentSessionMessages.role, "user")),
    )
    .orderBy(desc(agentSessionMessages.createdAt))
    .limit(1);
  if (!latestUserMessage) return [];
  const rows = await getDb()
    .select({
      filename: agentSessionMessageAttachments.filename,
      mediaType: agentSessionMessageAttachments.mediaType,
      blobUrl: agentSessionMessageAttachments.blobUrl,
    })
    .from(agentSessionMessageAttachments)
    .where(
      and(
        eq(agentSessionMessageAttachments.messageId, latestUserMessage.id),
        eq(agentSessionMessageAttachments.sessionId, sessionId),
        eq(agentSessionMessageAttachments.workspaceId, workspaceId),
        eq(agentSessionMessageAttachments.kind, "image"),
      ),
    );
  return rows.map((r) => ({ filename: r.filename, mediaType: r.mediaType, blobUrl: r.blobUrl }));
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
  const prepResult = await linear.callTool("prepare_attachment_upload", {
    issue,
    filename: image.filename,
    contentType: image.mediaType,
    size: bytes.byteLength,
  });
  if (isMcpError(prepResult)) {
    throw new Error(`prepare_attachment_upload failed: ${mcpResultText(prepResult).slice(0, 300)}`);
  }
  const prep = parseMcpJson(prepResult);
  const uploadRequest = prep?.uploadRequest as
    | { url?: string; method?: string; headers?: Record<string, string> }
    | undefined;
  const assetUrl = typeof prep?.assetUrl === "string" ? prep.assetUrl : undefined;
  if (!uploadRequest?.url || !assetUrl) {
    throw new Error("prepare_attachment_upload returned no upload URL / assetUrl");
  }
  // Linear's signed PUT requires every returned header (content-type, x-goog-content-length-range,
  // …) — without them GCS returns 403, so fail loudly rather than attempt a doomed request.
  if (!uploadRequest.headers) {
    throw new Error("prepare_attachment_upload returned no upload headers");
  }
  const put = await fetch(uploadRequest.url, {
    method: uploadRequest.method ?? "PUT",
    headers: uploadRequest.headers,
    // Buffer isn't a valid fetch BodyInit per the DOM types; copy into an ArrayBuffer-backed view.
    body: new Uint8Array(bytes),
    signal,
  });
  if (!put.ok) {
    throw new Error(`attachment upload PUT failed: ${put.status} ${put.statusText}`);
  }
  const finalizeResult = await linear.callTool("create_attachment_from_upload", {
    issue,
    assetUrl,
    title: image.filename,
  });
  if (isMcpError(finalizeResult)) {
    throw new Error(
      `create_attachment_from_upload failed: ${mcpResultText(finalizeResult).slice(0, 300)}`,
    );
  }
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
      `This workspace's Linear isn't connected (or the connection failed): ${errMessage(error)}. Ask the user to connect Linear in the Integrations tab, then try again.`,
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
    // The MCP client returns failures as { isError: true } rather than throwing — surface them as
    // real errors instead of reporting a phantom success to the user.
    if (isMcpError(createResult)) {
      return recoverable(
        "linear_issue_create_failed",
        `Linear rejected the issue: ${mcpResultText(createResult).slice(0, 500)}`,
      );
    }
    const created = parseMcpJson(createResult);
    const issueId = typeof created?.id === "string" ? created.id : undefined;
    const issueUrl = typeof created?.url === "string" ? created.url : undefined;
    if (!issueId) {
      // Don't claim success we can't confirm (and don't blindly retry → duplicate).
      return recoverable(
        "linear_issue_unconfirmed",
        `The issue may have been created, but Linear's response carried no issue id so I can't confirm it — check Linear before retrying. Response: ${mcpResultText(createResult).slice(0, 400)}`,
      );
    }

    // Step B: attach the dropped screenshot(s). Best-effort — a failed image must not fail the
    // issue (mirrors the feedback flow's resilience).
    let attachedImages = 0;
    let failedImages = 0;
    if (includeAttachments) {
      const images = await fetchLatestSessionImages(input.sessionId, input.workspaceId);
      for (const image of images) {
        try {
          await attachImageToIssue(linear, issueId, image, input.blobReadWriteToken, input.signal);
          attachedImages += 1;
        } catch (error) {
          failedImages += 1;
          captureException(error, {
            event: "opencompany.create_linear_issue_attachment_failed",
            session_id: input.sessionId,
            workspace_id: input.workspaceId,
            issue_id: issueId,
            filename: image.filename,
          });
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
