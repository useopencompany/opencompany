import { createHash } from "node:crypto";
import {
  agentPathForSlug,
  parseAgentFile,
  type RuntimeToolName,
  serializeAgentFile,
  slugifyAgentTitle,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { agentSessionArtifacts, agents, brainFiles } from "@opencompany/db/schema";
import { and, asc, eq, or } from "drizzle-orm";

const MAX_READ_BYTES = 256 * 1024;
const MAX_PROPOSAL_CHANGES = 8;
const PROPOSAL_KIND = "opencompany_config_proposal";

export async function executeWorkspaceConfigTool(input: {
  name: RuntimeToolName;
  args: unknown;
  workspaceId: string;
  sessionId: string;
  messageId: string;
  toolCallId: string;
}) {
  if (input.name === "opencompany_list_workspace_config") {
    return listWorkspaceConfig(input.workspaceId, input.args);
  }
  if (input.name === "opencompany_read_workspace_config") {
    return readWorkspaceConfig(input.workspaceId, input.args);
  }
  if (input.name === "opencompany_validate_agent") {
    return validateAgentSource(input.args);
  }
  if (input.name === "opencompany_propose_config_change") {
    return createConfigProposal(input);
  }
  throw new Error(`Unknown OpenCompany workspace tool: ${input.name}`);
}

async function listWorkspaceConfig(workspaceId: string, args: unknown) {
  const target = readString(asRecord(args).target) || "all";
  const db = getDb();
  const [agentRows, brainRows] = await Promise.all([
    target === "all" || target === "agents"
      ? db
          .select({
            id: agents.id,
            path: agents.path,
            title: agents.name,
            version: agents.version,
            contentHash: agents.contentHash,
            updatedAt: agents.updatedAt,
          })
          .from(agents)
          .where(eq(agents.workspaceId, workspaceId))
          .orderBy(asc(agents.path))
          .limit(100)
      : Promise.resolve([]),
    target === "all" || target === "brain"
      ? db
          .select({
            path: brainFiles.path,
            sizeBytes: brainFiles.sizeBytes,
            contentHash: brainFiles.contentHash,
            updatedAt: brainFiles.updatedAt,
          })
          .from(brainFiles)
          .where(eq(brainFiles.workspaceId, workspaceId))
          .orderBy(asc(brainFiles.path))
          .limit(200)
      : Promise.resolve([]),
  ]);

  return {
    agents: agentRows.map((agent) => ({
      ...agent,
      updatedAt: agent.updatedAt.toISOString(),
    })),
    brain: brainRows.map((file) => ({
      ...file,
      updatedAt: file.updatedAt.toISOString(),
    })),
  };
}

async function readWorkspaceConfig(workspaceId: string, args: unknown) {
  const record = asRecord(args);
  const targetType = readString(record.targetType);
  const id = optionalString(record.id);
  const path = optionalString(record.path);

  if (targetType === "agent") {
    if (!id && !path) throw new Error("Reading an agent requires id or path.");
    const [agent] = await getDb()
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          id && path
            ? or(eq(agents.id, id), eq(agents.path, path))
            : id
              ? eq(agents.id, id)
              : eq(agents.path, path ?? ""),
        ),
      )
      .limit(1);
    if (!agent) throw new Error("Agent not found.");
    const source = serializeAgentFile({
      title: agent.config.title,
      body: agent.config.instructions,
      model: agent.config.model.name,
      tools: agent.config.tools,
      brain: agent.config.brain,
      skills: agent.config.skills,
      integrations: agent.config.integrations,
      triggers: agent.config.triggers,
    });
    assertReadableSize(source, "Agent source");
    return {
      targetType: "agent",
      id: agent.id,
      path: agent.path,
      title: agent.name,
      version: agent.version,
      contentHash: agent.contentHash,
      source,
    };
  }

  if (targetType === "brain") {
    const normalizedPath = normalizeBrainPath(path ?? "");
    const [file] = await getDb()
      .select()
      .from(brainFiles)
      .where(and(eq(brainFiles.workspaceId, workspaceId), eq(brainFiles.path, normalizedPath)))
      .limit(1);
    if (!file) throw new Error("Brain file not found.");
    assertReadableSize(file.content, "Brain file");
    return {
      targetType: "brain",
      path: file.path,
      sizeBytes: file.sizeBytes,
      contentHash: file.contentHash,
      content: file.content,
    };
  }

  throw new Error("targetType must be agent or brain.");
}

function validateAgentSource(args: unknown) {
  const source = readString(asRecord(args).source);
  const validation = validateAgent(source);
  return {
    ok: validation.errors.length === 0,
    errors: validation.errors,
    warnings: validation.warnings,
    ...(validation.parsed
      ? {
          title: validation.parsed.title,
          config: {
            model: validation.parsed.config.model.name,
            tools: validation.parsed.config.tools.map((tool) => tool.id),
            brain: validation.parsed.config.brain,
            skills: validation.parsed.config.skills ?? [],
          },
          canonicalSource: serializeParsedAgent(validation.parsed),
        }
      : {}),
  };
}

async function createConfigProposal(input: {
  args: unknown;
  workspaceId: string;
  sessionId: string;
  messageId: string;
  toolCallId: string;
}) {
  const record = asRecord(input.args);
  const summary = readString(record.summary).trim();
  if (!summary) throw new Error("Proposal summary is required.");
  if (!Array.isArray(record.changes) || record.changes.length === 0) {
    throw new Error("At least one proposal change is required.");
  }
  if (record.changes.length > MAX_PROPOSAL_CHANGES) {
    throw new Error(`A proposal can include at most ${MAX_PROPOSAL_CHANGES} changes.`);
  }

  const changes = [];
  for (const rawChange of record.changes) {
    changes.push(await normalizeProposalChange(input.workspaceId, asRecord(rawChange)));
  }

  const [artifact] = await getDb()
    .insert(agentSessionArtifacts)
    .values({
      sessionId: input.sessionId,
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      toolName: "opencompany_propose_config_change",
      kind: PROPOSAL_KIND,
      title: summary,
      metadata: {
        status: "pending",
        summary,
        changes,
      },
    })
    .returning({ id: agentSessionArtifacts.id });

  return {
    proposalId: artifact?.id,
    status: "pending",
    summary,
    changes: changes.map((change) => summarizeChange(change)),
  };
}

async function normalizeProposalChange(workspaceId: string, change: Record<string, unknown>) {
  const targetType = readString(change.targetType);
  const operation = readString(change.operation);
  if (operation !== "create" && operation !== "update") {
    throw new Error("Proposal changes must use operation create or update.");
  }

  if (targetType === "agent") {
    const source = readString(change.source);
    const validation = validateAgent(source);
    if (validation.errors.length > 0 || !validation.parsed) {
      throw new Error(`Invalid agent source: ${validation.errors.join("; ")}`);
    }
    assertReadableSize(source, "Agent source");

    const target = resolveAgentProposalTarget({
      operation,
      id: optionalString(change.id),
      path: optionalString(change.path),
      title: validation.parsed.title,
      existingAgents: await listAgentProposalCandidates(workspaceId),
    });

    return {
      targetType: "agent",
      operation: target.operation,
      id: target.existing?.id ?? null,
      path: target.existing?.path ?? target.path,
      title: validation.parsed.title,
      source,
      previousHash: target.existing?.contentHash ?? null,
      previousVersion: target.existing?.version ?? null,
      warnings: validation.warnings,
    };
  }

  if (targetType === "brain") {
    const path = normalizeBrainPath(readString(change.path));
    const content = readString(change.content);
    assertReadableSize(content, "Brain file");
    const [existing] = await getDb()
      .select({
        path: brainFiles.path,
        contentHash: brainFiles.contentHash,
      })
      .from(brainFiles)
      .where(and(eq(brainFiles.workspaceId, workspaceId), eq(brainFiles.path, path)))
      .limit(1);
    if (operation === "update" && !existing) {
      throw new Error("Brain update proposals require an existing Brain file.");
    }
    if (operation === "create" && existing) {
      throw new Error("Brain create proposal target already exists.");
    }

    return {
      targetType: "brain",
      operation,
      path,
      content,
      previousHash: existing?.contentHash ?? null,
      contentHash: hashContent(content),
    };
  }

  throw new Error("Proposal targetType must be agent or brain.");
}

type AgentProposalCandidate = {
  id: string;
  path: string | null;
  name: string;
  contentHash: string | null;
  version: number;
};

export function resolveAgentProposalTarget(input: {
  operation: "create" | "update";
  id: string | null;
  path: string | null;
  title: string;
  existingAgents: AgentProposalCandidate[];
}) {
  const canonicalPath = agentPathForSlug(slugifyAgentTitle(input.title));
  const directMatch =
    input.id || input.path
      ? input.existingAgents.find(
          (agent) =>
            (input.id ? agent.id === input.id : false) ||
            (input.path ? agent.path === input.path : false),
        )
      : null;
  const canonicalPathMatch = input.existingAgents.find((agent) => agent.path === canonicalPath);
  const titleMatches = input.existingAgents.filter((agent) => agent.name === input.title);
  const titleMatch = titleMatches.length === 1 ? titleMatches[0] : null;
  const existing = directMatch ?? canonicalPathMatch ?? titleMatch ?? null;

  if (!existing && titleMatches.length > 1) {
    throw new Error("Multiple agents have this title. Include the existing agent id or path.");
  }
  if (input.operation === "update" && !existing) {
    throw new Error("Agent update proposals require an existing agent id or path.");
  }

  return {
    operation: input.operation === "create" && existing ? "update" : input.operation,
    existing,
    path: canonicalPath,
  };
}

async function listAgentProposalCandidates(workspaceId: string) {
  return getDb()
    .select({
      id: agents.id,
      path: agents.path,
      name: agents.name,
      contentHash: agents.contentHash,
      version: agents.version,
    })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId))
    .orderBy(asc(agents.path));
}

function validateAgent(source: string) {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!source.trim()) errors.push("Agent source is empty.");

  try {
    const parsed = parseAgentFile(source);
    if (!parsed.body.trim()) warnings.push("Agent body is empty.");
    if (!(parsed.config.skills ?? []).includes("opencompany")) {
      warnings.push("Agent source does not enable the opencompany skill.");
    }
    return { parsed, errors, warnings };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Agent source could not be parsed.");
    return { parsed: null, errors, warnings };
  }
}

function serializeParsedAgent(parsed: ReturnType<typeof parseAgentFile>) {
  return serializeAgentFile({
    title: parsed.title,
    body: parsed.body,
    model: parsed.config.model.name,
    tools: parsed.config.tools,
    brain: parsed.config.brain,
    skills: parsed.config.skills,
    integrations: parsed.config.integrations,
    triggers: parsed.config.triggers,
  });
}

function summarizeChange(change: Record<string, unknown>) {
  return {
    targetType: change.targetType,
    operation: change.operation,
    id: change.id,
    path: change.path,
    title: change.title,
    warnings: change.warnings,
  };
}

function normalizeBrainPath(input: string) {
  const raw = input
    .trim()
    .replace(/^brain\//, "")
    .replace(/^\/+/, "");
  const path = raw.split("/").filter(Boolean).join("/");
  if (!path || path.startsWith(".") || path.includes("..")) {
    throw new Error("Brain path must be a relative path inside brain/.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)) {
    throw new Error("Brain path contains unsupported characters.");
  }
  return path;
}

function assertReadableSize(content: string, label: string) {
  if (Buffer.byteLength(content, "utf8") > MAX_READ_BYTES) {
    throw new Error(`${label} must be ${MAX_READ_BYTES} bytes or smaller.`);
  }
}

function hashContent(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown) {
  const valueString = readString(value).trim();
  return valueString || null;
}
