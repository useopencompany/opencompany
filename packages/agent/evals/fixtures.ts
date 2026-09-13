import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import type { ChatActionCatalog } from "../src/chat-ui";
import { ln } from "./scenarios/discovery";

// Full schemas captured from Linear's catalog, with synthetic execution results only.
const listIssues: ChatActionCatalog["actions"][number] = {
  id: `${ln}list_issues`,
  source: "plugin:linear:linear",
  permissionMode: "on",
  description:
    'List issues in the user\'s Linear workspace, including active Triage Intelligence suggestions for issues in triage. For my issues, use "me" as the assignee. Use "null" for no assignee.',
  params: {
    type: "object",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    properties: {
      team: { type: "string", description: "Team name or ID" },
      cycle: { type: "string", description: "Cycle name, number, or ID" },
      label: { type: "string", description: "Label name or ID" },
      limit: {
        type: "number",
        default: 50,
        maximum: 250,
        description: "Max results (default 50, max 250)",
      },
      query: { type: "string", description: "Search issue title or description" },
      state: { type: "string", description: "State type, name, or ID" },
      cursor: { type: "string", description: "Next page cursor" },
      fields: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "id",
            "uuid",
            "title",
            "description",
            "projectMilestone",
            "priority",
            "estimate",
            "url",
            "gitBranchName",
            "createdAt",
            "updatedAt",
            "archivedAt",
            "completedAt",
            "startedAt",
            "canceledAt",
            "dueDate",
            "slaStartedAt",
            "slaMediumRiskAt",
            "slaHighRiskAt",
            "slaBreachesAt",
            "slaType",
            "status",
            "statusType",
            "labels",
            "triageIntel",
            "createdBy",
            "createdById",
            "assignee",
            "assigneeId",
            "delegate",
            "delegateId",
            "project",
            "projectId",
            "parentId",
            "team",
            "teamId",
            "cycleId",
          ],
        },
        description:
          "Fields to include in each result. `id` is always included. Omit or pass an empty array for the default response.",
      },
      orderBy: {
        enum: ["createdAt", "updatedAt"],
        type: "string",
        default: "updatedAt",
        description: "Sort: createdAt | updatedAt",
      },
      project: {
        type: "string",
        description: "Project name, ID, identifier (e.g., P-ENG-123), or slug",
      },
      release: { type: "string", description: "Release ID or slug" },
      assignee: { type: ["string", "null"], description: 'User ID, name, email, or "me"' },
      delegate: {
        type: "string",
        description:
          'Agent name or ID. When the user asks to delegate to "Linear" or "the Linear agent", this refers to the "Linear" app user specifically',
      },
      parentId: { type: "string", description: "Parent issue ID or identifier (e.g., LIN-123)" },
      priority: { type: "number", description: "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low" },
      createdAt: {
        type: "string",
        description: "Created after: ISO-8601 date/duration (e.g., -P1D)",
      },
      updatedAt: {
        type: "string",
        description: "Updated after: ISO-8601 date/duration (e.g., -P1D)",
      },
      includeArchived: { type: "boolean", default: false, description: "Include archived items" },
    },
  },
};
export async function loadCatalog(): Promise<ChatActionCatalog> {
  const dir = new URL("../src/actions/test-fixtures/", import.meta.url);
  const posthog = JSON.parse(
    gunzipSync(await readFile(new URL("posthog-discovery.json.gz", dir))).toString("utf8"),
  ) as { source: ChatActionCatalog["sources"][number]; actions: ChatActionCatalog["actions"] };
  const linear = JSON.parse(
    await readFile(new URL("linear-discovery.json", dir), "utf8"),
  ) as typeof posthog;
  return {
    sources: [posthog.source, linear.source],
    actions: [...posthog.actions, ...linear.actions, listIssues],
  };
}
