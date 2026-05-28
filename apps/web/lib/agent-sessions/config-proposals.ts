export const OPENCOMPANY_CONFIG_PROPOSAL_KIND = "opencompany_config_proposal";

export type OpenCompanyConfigProposalStatus = "pending" | "applied" | "dismissed" | "failed";

export type OpenCompanyConfigProposalChange =
  | {
      targetType: "agent";
      operation: "create" | "update";
      id: string | null;
      path: string | null;
      title: string;
      source: string;
      previousHash: string | null;
      previousVersion: number | null;
      warnings?: string[];
    }
  | {
      targetType: "brain";
      operation: "create" | "update";
      path: string;
      content: string;
      previousHash: string | null;
      contentHash: string;
    };

export type OpenCompanyConfigProposal = {
  id: number;
  sessionId: string;
  messageId: string | null;
  toolCallId: string;
  title: string;
  status: OpenCompanyConfigProposalStatus;
  summary: string;
  changes: OpenCompanyConfigProposalChange[];
  createdAt: string;
  error: string | null;
};

export function placeOpenCompanyConfigProposals(
  proposals: OpenCompanyConfigProposal[],
  visibleMessageIds: string[],
) {
  const visibleMessageIdSet = new Set(visibleMessageIds);
  const byMessageId = new Map<string, OpenCompanyConfigProposal[]>();
  const orphaned: OpenCompanyConfigProposal[] = [];

  for (const proposal of [...proposals].sort(compareConfigProposals)) {
    if (proposal.messageId && visibleMessageIdSet.has(proposal.messageId)) {
      const existing = byMessageId.get(proposal.messageId);
      if (existing) {
        existing.push(proposal);
      } else {
        byMessageId.set(proposal.messageId, [proposal]);
      }
      continue;
    }

    orphaned.push(proposal);
  }

  return { byMessageId, orphaned };
}

export function parseOpenCompanyConfigProposal(input: {
  id: number;
  sessionId: string;
  messageId: string | null;
  toolCallId: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}): OpenCompanyConfigProposal | null {
  const metadata = input.metadata ?? {};
  const status = readStatus(metadata.status);
  const summary = readString(metadata.summary) || input.title || "Workspace config proposal";
  const changes = Array.isArray(metadata.changes)
    ? metadata.changes.flatMap((change) => parseProposalChange(change))
    : [];
  if (changes.length === 0) return null;

  return {
    id: input.id,
    sessionId: input.sessionId,
    messageId: input.messageId,
    toolCallId: input.toolCallId,
    title: input.title ?? summary,
    status,
    summary,
    changes,
    createdAt: input.createdAt.toISOString(),
    error: optionalString(metadata.error),
  };
}

export function proposalMetadata(input: {
  status: OpenCompanyConfigProposalStatus;
  summary: string;
  changes: OpenCompanyConfigProposalChange[];
  error?: string | null;
}) {
  return {
    status: input.status,
    summary: input.summary,
    changes: input.changes,
    error: input.error ?? null,
  };
}

function parseProposalChange(value: unknown): OpenCompanyConfigProposalChange[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const targetType = readString(record.targetType);
  const operation = readString(record.operation);
  if (operation !== "create" && operation !== "update") return [];

  if (targetType === "agent") {
    const source = readString(record.source);
    const title = readString(record.title);
    if (!source || !title) return [];
    const warnings = Array.isArray(record.warnings)
      ? record.warnings.flatMap((warning) => (typeof warning === "string" ? [warning] : []))
      : [];
    return [
      {
        targetType,
        operation,
        id: optionalString(record.id),
        path: optionalString(record.path),
        title,
        source,
        previousHash: optionalString(record.previousHash),
        previousVersion:
          typeof record.previousVersion === "number" && Number.isFinite(record.previousVersion)
            ? record.previousVersion
            : null,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    ];
  }

  if (targetType === "brain") {
    const path = readString(record.path);
    const content = readString(record.content);
    if (!path) return [];
    return [
      {
        targetType,
        operation,
        path,
        content,
        previousHash: optionalString(record.previousHash),
        contentHash: readString(record.contentHash),
      },
    ];
  }

  return [];
}

function compareConfigProposals(left: OpenCompanyConfigProposal, right: OpenCompanyConfigProposal) {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  const leftSortableTime = Number.isFinite(leftTime) ? leftTime : 0;
  const rightSortableTime = Number.isFinite(rightTime) ? rightTime : 0;
  if (leftSortableTime !== rightSortableTime) return leftSortableTime - rightSortableTime;
  return left.id - right.id;
}

function readStatus(value: unknown): OpenCompanyConfigProposalStatus {
  if (value === "applied" || value === "dismissed" || value === "failed") return value;
  return "pending";
}

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown) {
  const stringValue = readString(value).trim();
  return stringValue || null;
}
