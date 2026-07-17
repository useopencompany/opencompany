import { MOCK_TOOL_CATALOG } from "./catalog";
import type { CatalogTraceEvent, JsonSchema, MockTool, SearchResult } from "./types";

type JsonRecord = Record<string, unknown>;

const FIXTURES = {
  linearIssues: [
    {
      id: "lin_142",
      identifier: "OC-142",
      title: "OAuth callback intermittently fails",
      description: "Some customers see a state mismatch after returning from the IdP.",
      status: "In Progress",
      priority: 1,
      project: "Atlas",
      assignee: "Maya Chen",
      url: "https://linear.example/OC-142",
    },
    {
      id: "lin_155",
      identifier: "OC-155",
      title: "Large workspace export times out",
      description: "Exports above 20k records exceed the worker deadline.",
      status: "Todo",
      priority: 2,
      project: "Atlas",
      assignee: "Jon Bell",
      url: "https://linear.example/OC-155",
    },
    {
      id: "lin_133",
      identifier: "OC-133",
      title: "Refresh onboarding screenshots",
      description: "Update screenshots after the navigation redesign.",
      status: "Done",
      priority: 3,
      project: "Atlas",
      assignee: "Maya Chen",
      url: "https://linear.example/OC-133",
    },
  ],
  githubIssues: [
    {
      id: "ghi_431",
      number: 431,
      repository: "opencompany/goat",
      title: "Audit log omits connector actor",
      body: "Customer report: audit events from connected apps have no actor.",
      state: "open",
      labels: ["customer", "bug"],
      url: "https://github.example/opencompany/goat/issues/431",
    },
    {
      id: "ghi_427",
      number: 427,
      repository: "opencompany/goat",
      title: "Add compact density preference",
      body: "Requested by two design partners.",
      state: "open",
      labels: ["customer", "enhancement"],
      url: "https://github.example/opencompany/goat/issues/427",
    },
  ],
  pullRequests: [
    {
      number: 42,
      repository: "opencompany/goat",
      title: "Make connector retries idempotent",
      state: "open",
      mergeable: true,
      checks: "passing",
      reviewDecision: "review_required",
      url: "https://github.example/opencompany/goat/pull/42",
    },
    {
      number: 77,
      repository: "opencompany/goat",
      title: "Ship the workspace activity digest",
      state: "open",
      mergeable: true,
      checks: "passing",
      reviewDecision: "approved",
      url: "https://github.example/opencompany/goat/pull/77",
    },
    {
      number: 88,
      repository: "opencompany/goat",
      title: "Fix retry accounting",
      state: "open",
      mergeable: false,
      checks: "failing",
      reviewDecision: "approved",
      url: "https://github.example/opencompany/goat/pull/88",
    },
    {
      number: 91,
      repository: "opencompany/goat",
      title: "Harden webhook verification",
      state: "open",
      mergeable: true,
      checks: "passing",
      reviewDecision: "approved",
      url: "https://github.example/opencompany/goat/pull/91",
    },
  ],
  slackChannels: [
    { id: "C_TRIAGE", name: "eng-triage", topic: "Engineering incident and bug triage" },
    { id: "C_SALES", name: "sales", topic: "Revenue team" },
    { id: "C_RELEASES", name: "releases", topic: "Release coordination" },
  ],
  notionPages: [
    {
      id: "notion_acme",
      title: "Acme Corp — Account Plan",
      content: "Renewal: 2026-08-31\nHealth: At risk\nOwner: Maya Chen",
      url: "https://notion.example/acme-account-plan",
    },
    {
      id: "notion_launch",
      title: "Launch blockers",
      content:
        "- Fix OAuth callback race [owner: Maya]\n- Verify export worker limits [owner: Jon]\n- Update runbook links [owner: Priya]",
      url: "https://notion.example/launch-blockers",
    },
  ],
  attioRecords: [
    {
      id: "attio_acme",
      object: "companies",
      name: "Acme Corp",
      domain: "acme.example",
      stage: "Customer",
      renewalDate: "2026-08-31",
      health: "At risk",
      owner: "maya@opencompany.example",
    },
    {
      id: "rec_acme_robotics",
      object: "companies",
      name: "Acme Robotics",
      domain: "acmerobotics.example",
      stage: "growth",
      renewalDate: "2026-10-15",
      health: "Healthy",
      owner: "jon@opencompany.example",
    },
    {
      id: "rec_northstar",
      object: "companies",
      name: "Northstar",
      domain: "northstar.example",
      stage: "prospect",
      renewalDate: null,
      health: "Evaluating",
      owner: "maya@opencompany.example",
    },
  ],
  gmailMessages: [
    {
      id: "gmail_maya_renewal",
      threadId: "gmail_thread_renewal",
      from: "Maya Chen <maya@acme.example>",
      to: ["sales@opencompany.example"],
      subject: "Acme renewal — security review timing",
      body: "Can you confirm the security review is complete by August 5? This is blocking renewal approval.",
      date: "2026-07-16T09:30:00Z",
    },
  ],
} as const;

export class CatalogService {
  readonly trace: CatalogTraceEvent[] = [];
  readonly mutations: Array<{ path: string; input: JsonRecord; output: unknown }> = [];

  private readonly byPath = new Map(MOCK_TOOL_CATALOG.map((item) => [item.path, item]));
  private nextLinearIssue = 200;
  private nextMutation = 1;

  search(query: string, limit = 5): SearchResult[] {
    const started = performance.now();
    const normalized = normalizeSearchText(query);
    const queryTerms = terms(normalized);
    const ranked = MOCK_TOOL_CATALOG.map((item) => {
      const pathText = normalizeSearchText(item.path);
      const haystack = `${pathText} ${normalizeSearchText(item.summary)}`;
      let score = queryTerms.reduce((total, term) => {
        if (pathText.includes(term)) return total + 7;
        if (haystack.includes(term)) return total + 3;
        return total;
      }, 0);
      if (haystack.includes(normalized)) score += 12;
      if (queryTerms[0] === item.integration) score += 10;
      return { path: item.path, summary: item.summary, score };
    })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, clampLimit(limit));

    this.trace.push({
      at: new Date().toISOString(),
      kind: "search",
      query,
      output: ranked,
      durationMs: elapsed(started),
    });
    return ranked;
  }

  describe(path: string) {
    const started = performance.now();
    const item = this.requireTool(path);
    const detail = {
      path: item.path,
      summary: item.summary,
      inputSchema: item.inputSchema,
      outputSchema: item.outputSchema,
    };
    this.trace.push({
      at: new Date().toISOString(),
      kind: "describe",
      path,
      output: detail,
      durationMs: elapsed(started),
    });
    return detail;
  }

  async invoke(path: string, rawInput: unknown) {
    const started = performance.now();
    try {
      const item = this.requireTool(path);
      const input = validateInput(item, rawInput);
      const output = await this.executeMock(item, input);
      this.trace.push({
        at: new Date().toISOString(),
        kind: "invoke",
        path,
        input,
        output,
        durationMs: elapsed(started),
      });
      if (isMutation(item.operation)) this.mutations.push({ path, input, output });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.trace.push({
        at: new Date().toISOString(),
        kind: "invoke_error",
        path,
        input: rawInput,
        error: message,
        errorKind: error instanceof CatalogError ? error.kind : "runtime",
        durationMs: elapsed(started),
      });
      throw error;
    }
  }

  private requireTool(path: string) {
    const item = this.byPath.get(path);
    if (!item) throw new CatalogError("unknown_tool", `Unknown tool path: ${path}`);
    return item;
  }

  private async executeMock(item: MockTool, input: JsonRecord): Promise<unknown> {
    const { path, integration, operation } = item;

    if (path === "linear.search_issues" || path === "linear.list_issues") {
      const records = filterRecords(FIXTURES.linearIssues, input, [
        "identifier",
        "title",
        "description",
        "project",
        "status",
        "assignee",
      ]).sort((left, right) => left.priority - right.priority);
      return response(records);
    }
    if (path === "linear.get_issue") {
      return response(
        findRecord(FIXTURES.linearIssues, input.issueId ?? input.issue_id, ["id", "identifier"]),
      );
    }
    if (path === "linear.create_issue") {
      const identifier = `OC-${this.nextLinearIssue++}`;
      return response({
        id: `lin_${identifier.slice(3)}`,
        identifier,
        url: `https://linear.example/${identifier}`,
        ...input,
      });
    }
    if (path === "github.search_issues" || path === "github.list_issues") {
      return response(filterRecords(FIXTURES.githubIssues, input, ["title", "body", "repository"]));
    }
    if (path === "github.get_issue") {
      return response(
        FIXTURES.githubIssues.find(
          (issue) => issue.repository === input.repository && issue.number === input.issue_number,
        ) ?? null,
      );
    }
    if (path === "github.get_pull_request") {
      const repository =
        typeof input.repository === "string" ? input.repository : `${input.owner}/${input.repo}`;
      const pullNumber = input.pullNumber ?? input.pull_number;
      return response(
        FIXTURES.pullRequests.find(
          (pull) => pull.repository === repository && pull.number === pullNumber,
        ) ?? null,
      );
    }
    if (path === "github.list_pull_requests") {
      const repository = `${input.owner}/${input.repo}`;
      return response(
        FIXTURES.pullRequests.filter(
          (pull) => pull.repository === repository && (!input.state || pull.state === input.state),
        ),
      );
    }
    if (path === "github.merge_pull_request") {
      const pullNumber = input.pullNumber ?? input.pull_number;
      if (pullNumber === 91) {
        throw new CatalogError(
          "tool_error",
          "GitHub rejected the merge: branch protection requires the security-review check.",
        );
      }
      const pull = FIXTURES.pullRequests.find((candidate) => candidate.number === pullNumber);
      if (!pull?.mergeable) {
        throw new CatalogError(
          "tool_error",
          "GitHub rejected the merge: pull request is not mergeable.",
        );
      }
      return response({ merged: true, sha: "mock_merge_sha" });
    }
    if (path === "slack.list_channels") {
      return response(filterRecords(FIXTURES.slackChannels, input, ["id", "name", "topic"]));
    }
    if (path === "slack.get_channel") {
      return response(findRecord(FIXTURES.slackChannels, input.channel, ["id", "name"]));
    }
    if (path === "slack.search_messages") {
      return response([
        {
          channelId: "CENG123",
          threadTs: "1712345678.000100",
          timestamp: "1712345678.000100",
          user: "Maya Chen",
          text: "Pricing migration rollback and mobile login loop are being tracked by the release team.",
        },
      ]);
    }
    if (path === "slack.fetch_thread") {
      return response({
        root: {
          channelId: input.channelId,
          threadTs: input.threadTs,
          text: "Pricing migration rollback is ready if login errors increase.",
        },
        replies: [{ user: "Jon Bell", text: "The mobile login loop points to stale OAuth state." }],
      });
    }
    if (path === "slack.create_channel") {
      const name = String(input.name).replace(/^#/, "");
      return response({ id: `C_NEW_${this.nextMutation++}`, name, ...input });
    }
    if (path === "slack.post_message" || path === "slack.reply_to_thread") {
      return response({
        channel: input.channel,
        timestamp: `1720000000.${String(this.nextMutation++).padStart(3, "0")}`,
        text: input.text,
      });
    }
    if (
      path === "notion.search" ||
      path === "notion.search_pages" ||
      path === "notion.list_pages"
    ) {
      return response(filterRecords(FIXTURES.notionPages, input, ["id", "title", "content"]));
    }
    if (path === "notion.get_page") {
      return response(findRecord(FIXTURES.notionPages, input.page_id, ["id", "title"]));
    }
    if (path === "attio.search_records" || path === "attio.list_records") {
      return response(
        filterRecords(FIXTURES.attioRecords, input, ["id", "name", "domain", "stage"]),
      );
    }
    if (path === "attio.get_record") {
      return response(findRecord(FIXTURES.attioRecords, input.record_id, ["id", "name", "domain"]));
    }
    if (path === "gmail.search_messages") {
      return response(filterRecords(FIXTURES.gmailMessages, input, ["from", "subject", "body"]));
    }
    if (path === "gmail.get_message") {
      return response(findRecord(FIXTURES.gmailMessages, input.message_id, ["id"]));
    }
    if (path === "gmail.get_thread") {
      return response(
        FIXTURES.gmailMessages.filter((message) => message.threadId === input.thread_id),
      );
    }

    if (isMutation(operation)) {
      return response({
        id: `mock_${integration}_${operation}_${this.nextMutation++}`,
        ...input,
        updatedAt: "2026-07-17T12:00:00.000Z",
      });
    }

    return response({
      integration,
      operation,
      records: [],
      note: "The mock catalog has no seeded records for this read operation.",
    });
  }
}

export class CatalogError extends Error {
  constructor(
    readonly kind: "unknown_tool" | "invalid_input" | "tool_error",
    message: string,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

function validateInput(tool: MockTool, rawInput: unknown): JsonRecord {
  if (!isRecord(rawInput)) {
    throw new CatalogError("invalid_input", `${tool.path} input must be a JSON object.`);
  }
  const properties = tool.inputSchema.properties ?? {};
  for (const required of tool.inputSchema.required ?? []) {
    if (
      !(required in rawInput) ||
      rawInput[required] === undefined ||
      rawInput[required] === null
    ) {
      throw new CatalogError(
        "invalid_input",
        `${tool.path} is missing required input: ${required}`,
      );
    }
  }
  if (tool.inputSchema.additionalProperties === false) {
    const unknown = Object.keys(rawInput).find((key) => !(key in properties));
    if (unknown)
      throw new CatalogError("invalid_input", `${tool.path} has unknown input: ${unknown}`);
  }
  for (const [key, value] of Object.entries(rawInput)) {
    const schema = properties[key];
    if (!schema || value === undefined) continue;
    if (!matchesType(value, schema.type)) {
      throw new CatalogError(
        "invalid_input",
        `${tool.path}.${key} expected ${JSON.stringify(schema.type)}, received ${valueType(value)}.`,
      );
    }
  }
  return rawInput;
}

function matchesType(value: unknown, type: JsonSchema["type"]) {
  if (!type) return true;
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    if (candidate === "null") return value === null;
    if (candidate === "array") return Array.isArray(value);
    if (candidate === "object") return isRecord(value);
    if (candidate === "integer") return typeof value === "number" && Number.isInteger(value);
    return typeof value === candidate;
  });
}

function valueType(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function response(data: unknown) {
  return { ok: true, data, nextCursor: null };
}

function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .replace(/[_./-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function terms(value: string) {
  return normalizeSearchText(value)
    .split(" ")
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term));
}

const STOP_WORDS = new Set(["a", "an", "and", "by", "for", "in", "of", "on", "or", "the", "to"]);

function filterRecords<T extends object>(
  records: readonly T[],
  input: JsonRecord,
  fields: string[],
) {
  const query = typeof input.query === "string" ? terms(input.query) : [];
  return records.filter((record) => {
    const row = record as JsonRecord;
    if (query.length > 0) {
      const haystack = normalizeSearchText(
        fields.map((field) => String(row[field] ?? "")).join(" "),
      );
      if (!query.every((term) => haystack.includes(term))) return false;
    }
    for (const [key, value] of Object.entries(input)) {
      if (["query", "limit", "cursor", "filter", "sort"].includes(key) || value === undefined)
        continue;
      const candidate = row[key];
      if (Array.isArray(value)) {
        const candidateValues = Array.isArray(candidate) ? candidate.map(String) : [];
        if (!value.every((item) => candidateValues.includes(String(item)))) return false;
      } else if (
        candidate !== undefined &&
        normalizeSearchText(String(candidate)) !== normalizeSearchText(String(value))
      ) {
        return false;
      }
    }
    return true;
  });
}

function findRecord<T extends object>(records: readonly T[], needle: unknown, fields: string[]) {
  const normalized = normalizeSearchText(String(needle ?? ""));
  return (
    records.find((record) => {
      const row = record as JsonRecord;
      return fields.some((field) => normalizeSearchText(String(row[field] ?? "")) === normalized);
    }) ?? null
  );
}

function isMutation(operation: string) {
  return /^(create|update|add|post|reply|send|merge|assign|archive|trash|remove|invite|set|delete)/.test(
    operation,
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampLimit(limit: number) {
  if (!Number.isFinite(limit)) return 5;
  return Math.max(1, Math.min(20, Math.floor(limit)));
}

function elapsed(started: number) {
  return Math.max(0, Math.round((performance.now() - started) * 1000) / 1000);
}
