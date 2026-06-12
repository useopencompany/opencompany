import { connectWorkspaceMcpClient, type WorkspaceMcpToolClient } from "./mcp-tools";

// create_linear_issue (kind: "internal") runs in the runner, not the sandbox. It creates an issue
// in the workspace's OWN connected Linear by driving that workspace's Linear MCP connection (the
// same decrypted OAuth credential the agent's `linear__use_tool` uses) — NOT OpenCompany's internal
// LINEAR_API_KEY feedback Linear. Step A creates a text issue; the dropped-screenshot attachment is
// added in a follow-up step.

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

export async function runCreateLinearIssueTool(input: {
  workspaceId: string;
  args: unknown;
  integrationCredentialEncryptionKey: Buffer;
  signal: AbortSignal;
}): Promise<unknown> {
  const args = (input.args ?? {}) as Record<string, unknown>;
  const title = typeof args.title === "string" ? args.title.trim() : "";
  const description = typeof args.description === "string" ? args.description : "";
  const teamArg = typeof args.team === "string" ? args.team.trim() : "";
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

    const result = await linear.callTool("save_issue", issueArgs);
    return {
      ok: true,
      team,
      message: `Created a Linear issue in team "${team}".`,
      issue: mcpResultText(result),
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
