import { PGlite } from "@electric-sql/pglite";
import type { Actor } from "@opencompany/core";
import { snapshotPGliteSchema } from "@opencompany/db/test-schema-snapshot";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFeedbackService } from "./feedback";

const actor: Actor = {
  userId: "user_1",
  workspaceId: "workspace_1",
  role: "member",
  permissions: [],
  authenticationMethod: "session",
};

function linearFetch() {
  const issueInputs: Array<{ description: string }> = [];
  const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { input?: { description: string } };
    };
    if (body.query.includes("FeedbackTriageState")) {
      return Response.json({ data: { team: { states: { nodes: [] } } } });
    }
    if (body.query.includes("FeedbackLabels")) {
      return Response.json({ data: { team: { labels: { nodes: [] } } } });
    }
    if (body.query.includes("FeedbackCreateLabel")) {
      return Response.json({ data: { issueLabelCreate: { success: false, issueLabel: null } } });
    }
    if (body.variables.input) issueInputs.push(body.variables.input);
    return Response.json({
      data: { issueCreate: { success: true, issue: { id: "iss_1", identifier: "OC-1" } } },
    });
  });
  return { fetchImpl, issueInputs };
}

// The reference lines are the whole point of the feature, and they hang off an
// access predicate. Run it as real SQL so a wrong join or null rule shows up here
// rather than as a silently unreferenced bug report.
describe("feedback context resolution against real SQL", () => {
  let database: PGlite;
  let restoreDatabase: () => Promise<PGlite>;

  beforeAll(async () => {
    restoreDatabase = await snapshotPGliteSchema(async (database) => {
      await database.exec(`
        CREATE SCHEMA goat;
        CREATE TABLE goat.users (
          workos_user_id text PRIMARY KEY,
          email text NOT NULL,
          first_name text,
          last_name text
        );
        CREATE TABLE goat.workspaces (id text PRIMARY KEY, name text NOT NULL);
        CREATE TABLE goat.chat_sessions (id text PRIMARY KEY, user_workos_id text NOT NULL);
        CREATE TABLE goat.tasks (
          id text PRIMARY KEY,
          display_id text NOT NULL,
          user_workos_id text NOT NULL,
          workspace_id text,
          session_id text
        );
        INSERT INTO goat.users VALUES ('user_1', 'ana@acme.example', 'Ana', 'Ng');
        INSERT INTO goat.workspaces VALUES ('workspace_1', 'Acme');
        INSERT INTO goat.chat_sessions VALUES ('ses_mine', 'user_1'), ('ses_theirs', 'user_2');
        INSERT INTO goat.tasks (id, display_id, user_workos_id, workspace_id, session_id) VALUES
          ('tsk_workspace', 'TASK-1', 'user_2', 'workspace_1', 'ses_mine'),
          ('tsk_personal', 'TASK-2', 'user_1', NULL, NULL),
          ('tsk_other_workspace', 'TASK-3', 'user_2', 'workspace_2', NULL),
          ('tsk_other_personal', 'TASK-4', 'user_2', NULL, NULL);
      `);
    });
  });

  beforeEach(async () => {
    database = await restoreDatabase();
    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.OPENCOMPANY_FEEDBACK_LINEAR_TEAM_ID = "team_1";
    process.env.OPENCOMPANY_NEXT_PUBLIC_APP_URL = "https://my.opencompany.chat";
  });

  afterEach(async () => {
    await database.close();
    vi.restoreAllMocks();
    delete process.env.LINEAR_API_KEY;
    delete process.env.OPENCOMPANY_FEEDBACK_LINEAR_TEAM_ID;
    delete process.env.OPENCOMPANY_NEXT_PUBLIC_APP_URL;
  });

  async function describeFeedbackFrom(context: { kind: "chat" | "task"; id: string }) {
    const { fetchImpl, issueInputs } = linearFetch();
    const service = createFeedbackService({ db: drizzle(database), fetch: fetchImpl });
    await service.submit(actor, { kind: "bug", message: "Something broke.", context });
    return issueInputs[0]?.description ?? "";
  }

  it("resolves a task in the acting workspace with the session behind it", async () => {
    const description = await describeFeedbackFrom({ kind: "task", id: "tsk_workspace" });
    expect(description).toContain("Task: tsk_workspace (TASK-1)");
    expect(description).toContain("Session: ses_mine");
    expect(description).toContain("Link: https://my.opencompany.chat/tasks/tsk_workspace");
  });

  it("resolves the reporter's own task that predates a workspace", async () => {
    const description = await describeFeedbackFrom({ kind: "task", id: "tsk_personal" });
    expect(description).toContain("Task: tsk_personal (TASK-2)");
    expect(description).not.toContain("not accessible");
  });

  it("marks tasks the reporter cannot open", async () => {
    for (const id of ["tsk_other_workspace", "tsk_other_personal", "tsk_missing"]) {
      expect(await describeFeedbackFrom({ kind: "task", id })).toContain(
        `Task: ${id} (not accessible to the reporter)`,
      );
    }
  });

  it("resolves only the reporter's own chat sessions", async () => {
    expect(await describeFeedbackFrom({ kind: "chat", id: "ses_mine" })).toContain(
      "Session: ses_mine\nLink: https://my.opencompany.chat/chat/ses_mine",
    );
    expect(await describeFeedbackFrom({ kind: "chat", id: "ses_theirs" })).toContain(
      "Session: ses_theirs (not accessible to the reporter)",
    );
  });
});
