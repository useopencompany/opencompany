import { describe, expect, it } from "vitest";
import { buildElectricOriginUrl, hasInvalidElectricCloudSecretPair } from "@/lib/electric";

describe("buildElectricOriginUrl", () => {
  it("scopes goat.tasks to the active workspace plus legacy private tasks", () => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com/",
      requestUrl: new URL(
        "https://app.example.com/api/electric/v1/shape?table=goat.tasks&live=true&where=1=1",
      ),
      userWorkosId: "user_123",
      workspaceId: "workspace_123",
    });

    expect(url).not.toBeNull();
    expect(url?.origin).toBe("https://electric.example.com");
    expect(url?.pathname).toBe("/v1/shape");
    expect(url?.searchParams.get("table")).toBe("goat.tasks");
    expect(url?.searchParams.get("where")).toBe(
      '("workspace_id" = $2 OR ("workspace_id" IS NULL AND "user_workos_id" = $1))',
    );
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("params[2]")).toBe("workspace_123");
    expect(url?.searchParams.get("live")).toBe("true");
    expect(url?.searchParams.get("where")).not.toBe("1=1");
  });

  it("rejects unknown tables", () => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL("https://app.example.com/api/electric/v1/shape?table=users"),
      userWorkosId: "user_123",
    });

    expect(url).toBeNull();
  });

  it("scopes goat.task_messages to workspace-visible tasks and trusted task id", () => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://app.example.com/api/electric/v1/shape?table=goat.task_messages&task_id=goat_task_1&where=1=1",
      ),
      userWorkosId: "user_123",
      workspaceId: "workspace_123",
    });

    expect(url?.searchParams.get("table")).toBe("goat.task_messages");
    const where = url?.searchParams.get("where") ?? "";
    expect(where).toContain('"task_id" IN');
    expect(where).toContain('task."workspace_id" = $2');
    expect(where).toContain('"task_id" = $3');
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("params[2]")).toBe("workspace_123");
    expect(url?.searchParams.get("params[3]")).toBe("goat_task_1");
  });

  it("scopes goat.task_events to workspace-visible tasks when no task id is requested", () => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL("https://app.example.com/api/electric/v1/shape?table=goat.task_events"),
      userWorkosId: "user_123",
      workspaceId: "workspace_123",
    });

    expect(url?.searchParams.get("table")).toBe("goat.task_events");
    const where = url?.searchParams.get("where") ?? "";
    expect(where).toContain('"task_id" IN');
    expect(where).toContain('task."workspace_id" = $2');
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("params[2]")).toBe("workspace_123");
    expect(url?.searchParams.get("params[3]")).toBeNull();
  });

  it("scopes goat.chat_messages to an open chat owned by the user and trusted session id", () => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://app.example.com/api/electric/v1/shape?table=goat.chat_messages&session_id=goat_chat_1&where=1=1",
      ),
      userWorkosId: "user_123",
      authorizedChatSessionId: "goat_chat_1",
    });

    expect(url?.searchParams.get("table")).toBe("goat.chat_messages");
    expect(url?.searchParams.get("where")).toBe(`"session_id" = $1`);
    expect(url?.searchParams.get("params[1]")).toBe("goat_chat_1");
    expect(url?.searchParams.get("params[2]")).toBeNull();
  });

  it("rejects goat.chat_messages without a route-authorized session id", () => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://app.example.com/api/electric/v1/shape?table=goat.chat_messages&session_id=goat_chat_1",
      ),
      userWorkosId: "user_123",
    });

    expect(url).toBeNull();
  });

  it("scopes goat.chat_sessions to open sessions for the authenticated WorkOS user", () => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://app.example.com/api/electric/v1/shape?table=goat.chat_sessions&where=1=1",
      ),
      userWorkosId: "user_123",
    });

    expect(url?.searchParams.get("table")).toBe("goat.chat_sessions");
    expect(url?.searchParams.get("where")).toBe(`"user_workos_id" = $1 AND "closed_at" IS NULL`);
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("params[2]")).toBeNull();
    expect(url?.searchParams.get("where")).not.toBe("1=1");
  });

  it("scopes the global Codex session feed to the authenticated WorkOS user", () => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://app.example.com/api/electric/v1/shape?table=goat.codex_chat_sessions",
      ),
      userWorkosId: "user_123",
    });

    expect(url?.searchParams.get("table")).toBe("goat.codex_chat_sessions");
    expect(url?.searchParams.get("where")).toBe('"user_workos_id" = $1');
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("columns")).not.toContain("sandbox_id");
    expect(url?.searchParams.get("columns")).not.toContain("codex_thread_id");
  });

  it("keeps detail-scoped Codex session feeds bound to an authorized chat", () => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://app.example.com/api/electric/v1/shape?table=goat.codex_chat_sessions&chat_session_id=goat_chat_1",
      ),
      userWorkosId: "user_123",
      authorizedChatSessionId: "goat_chat_1",
    });

    expect(url?.searchParams.get("where")).toBe('"chat_session_id" = $1');
    expect(url?.searchParams.get("params[1]")).toBe("goat_chat_1");
  });

  it("rejects a detail-scoped Codex session feed for a different chat", () => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://app.example.com/api/electric/v1/shape?table=goat.codex_chat_sessions&chat_session_id=goat_chat_1",
      ),
      userWorkosId: "user_123",
      authorizedChatSessionId: "goat_chat_2",
    });

    expect(url).toBeNull();
  });

  it.each([
    "goat.task_model_usage",
    "goat.task_tool_usage",
    "goat.task_sandbox_usage",
  ])("scopes %s to workspace-visible tasks and trusted task id", (table) => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        `https://app.example.com/api/electric/v1/shape?table=${table}&task_id=goat_task_1&where=1=1`,
      ),
      userWorkosId: "user_123",
      workspaceId: "workspace_123",
    });

    expect(url?.searchParams.get("table")).toBe(table);
    const where = url?.searchParams.get("where") ?? "";
    expect(where).toContain('"task_id" IN');
    expect(where).toContain('task."workspace_id" = $2');
    expect(where).toContain('"task_id" = $3');
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("params[2]")).toBe("workspace_123");
    expect(url?.searchParams.get("params[3]")).toBe("goat_task_1");
  });

  it("scopes goat.integrations to the user's personal rows plus the active workspace", () => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL("https://app.example.com/api/electric/v1/shape?table=goat.integrations"),
      userWorkosId: "user_123",
      workspaceId: "gws_123",
    });

    expect(url?.searchParams.get("table")).toBe("goat.integrations");
    expect(url?.searchParams.get("where")).toBe(
      '("user_workos_id" = $1 AND "workspace_id" IS NULL) OR "workspace_id" = $2',
    );
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("params[2]")).toBe("gws_123");
  });

  it("scopes goat.integrations to personal rows only without a workspace context", () => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL("https://app.example.com/api/electric/v1/shape?table=goat.integrations"),
      userWorkosId: "user_123",
    });

    expect(url?.searchParams.get("where")).toBe('"user_workos_id" = $1 AND "workspace_id" IS NULL');
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("params[2]")).toBeNull();
  });

  it.each([
    "goat.brain_folders",
    "goat.brain_documents",
    "goat.brain_timeline_entries",
    "goat.brain_edges",
    "goat.brain_ingest_jobs",
  ])("scopes %s to the route-authorized brain ref", (table) => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        `https://app.example.com/api/electric/v1/shape?table=${table}&brain_ref=goat_brain_1&where=1=1`,
      ),
      userWorkosId: "user_123",
      authorizedBrainRef: "goat_brain_1",
    });

    expect(url?.searchParams.get("table")).toBe(table);
    expect(url?.searchParams.get("where")).toBe('"brain_ref" = $1');
    expect(url?.searchParams.get("params[1]")).toBe("goat_brain_1");
    expect(url?.searchParams.get("params[2]")).toBeNull();
  });

  it.each([
    "goat.brain_documents without a route-authorized brain ref",
    "goat.brain_documents with a mismatched authorized brain ref",
  ])("rejects %s", (label) => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://app.example.com/api/electric/v1/shape?table=goat.brain_documents&brain_ref=goat_brain_1",
      ),
      userWorkosId: "user_123",
      ...(label.includes("mismatched") ? { authorizedBrainRef: "goat_brain_other" } : {}),
    });

    expect(url).toBeNull();
  });

  it("scopes goat.brain_source_items to the user and strips the payload columns", () => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://app.example.com/api/electric/v1/shape?table=goat.brain_source_items",
      ),
      userWorkosId: "user_123",
    });

    expect(url?.searchParams.get("table")).toBe("goat.brain_source_items");
    expect(url?.searchParams.get("where")).toBe('"user_workos_id" = $1');
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    const columns = url?.searchParams.get("columns")?.split(",") ?? [];
    expect(columns).toContain("id");
    expect(columns).toContain("title");
    expect(columns).not.toContain("raw_payload");
    expect(columns).not.toContain("normalized_payload");
  });

  it("allows safe goat.brain_source_items filters", () => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://app.example.com/api/electric/v1/shape?table=goat.brain_source_items&source_provider=goat-chat&source_type=capture&last_ingest_status=pending,skipped,failed",
      ),
      userWorkosId: "user_123",
    });

    expect(url?.searchParams.get("where")).toBe(
      `"user_workos_id" = $1 AND "source_provider" = $2 AND "source_type" = $3 AND "last_ingest_status" IN ($4, $5, $6)`,
    );
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("params[2]")).toBe("goat-chat");
    expect(url?.searchParams.get("params[3]")).toBe("capture");
    expect(url?.searchParams.get("params[4]")).toBe("pending");
    expect(url?.searchParams.get("params[5]")).toBe("skipped");
    expect(url?.searchParams.get("params[6]")).toBe("failed");
  });

  it("rejects unsafe goat.brain_source_items filters", () => {
    const url = buildElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://app.example.com/api/electric/v1/shape?table=goat.brain_source_items&source_provider=other",
      ),
      userWorkosId: "user_123",
    });

    expect(url).toBeNull();
  });

  it("requires Electric Cloud source id and secret together", () => {
    expect(hasInvalidElectricCloudSecretPair({ sourceId: "source", sourceSecret: "" })).toBe(true);
    expect(hasInvalidElectricCloudSecretPair({ sourceId: "source", sourceSecret: "secret" })).toBe(
      false,
    );
  });
});
