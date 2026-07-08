import { describe, expect, it } from "vitest";
import { buildGoatElectricOriginUrl, hasInvalidElectricCloudSecretPair } from "@/lib/electric";

describe("buildGoatElectricOriginUrl", () => {
  it("scopes goat.tasks to the authenticated WorkOS user", () => {
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com/",
      requestUrl: new URL(
        "https://goat.example.com/api/electric/v1/shape?table=goat.tasks&live=true&where=1=1",
      ),
      userWorkosId: "user_123",
    });

    expect(url).not.toBeNull();
    expect(url?.origin).toBe("https://electric.example.com");
    expect(url?.pathname).toBe("/v1/shape");
    expect(url?.searchParams.get("table")).toBe("goat.tasks");
    expect(url?.searchParams.get("where")).toBe('"user_workos_id" = $1');
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("live")).toBe("true");
    expect(url?.searchParams.get("where")).not.toBe("1=1");
  });

  it("rejects unknown tables", () => {
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL("https://goat.example.com/api/electric/v1/shape?table=users"),
      userWorkosId: "user_123",
    });

    expect(url).toBeNull();
  });

  it("scopes goat.task_messages to the user and trusted task id", () => {
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://goat.example.com/api/electric/v1/shape?table=goat.task_messages&task_id=goat_task_1&where=1=1",
      ),
      userWorkosId: "user_123",
    });

    expect(url?.searchParams.get("table")).toBe("goat.task_messages");
    expect(url?.searchParams.get("where")).toBe('"user_workos_id" = $1 AND "task_id" = $2');
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("params[2]")).toBe("goat_task_1");
  });

  it("scopes goat.task_events to the user when no task id is requested", () => {
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL("https://goat.example.com/api/electric/v1/shape?table=goat.task_events"),
      userWorkosId: "user_123",
    });

    expect(url?.searchParams.get("table")).toBe("goat.task_events");
    expect(url?.searchParams.get("where")).toBe('"user_workos_id" = $1');
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("params[2]")).toBeNull();
  });

  it("scopes goat.chat_messages to an open chat owned by the user and trusted session id", () => {
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://goat.example.com/api/electric/v1/shape?table=goat.chat_messages&session_id=goat_chat_1&where=1=1",
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
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://goat.example.com/api/electric/v1/shape?table=goat.chat_messages&session_id=goat_chat_1",
      ),
      userWorkosId: "user_123",
    });

    expect(url).toBeNull();
  });

  it("scopes goat.chat_sessions to open sessions for the authenticated WorkOS user", () => {
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://goat.example.com/api/electric/v1/shape?table=goat.chat_sessions&where=1=1",
      ),
      userWorkosId: "user_123",
    });

    expect(url?.searchParams.get("table")).toBe("goat.chat_sessions");
    expect(url?.searchParams.get("where")).toBe(`"user_workos_id" = $1 AND "closed_at" IS NULL`);
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("params[2]")).toBeNull();
    expect(url?.searchParams.get("where")).not.toBe("1=1");
  });

  it.each([
    "goat.task_model_usage",
    "goat.task_tool_usage",
    "goat.task_sandbox_usage",
  ])("scopes %s to the user and trusted task id", (table) => {
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        `https://goat.example.com/api/electric/v1/shape?table=${table}&task_id=goat_task_1&where=1=1`,
      ),
      userWorkosId: "user_123",
    });

    expect(url?.searchParams.get("table")).toBe(table);
    expect(url?.searchParams.get("where")).toBe('"user_workos_id" = $1 AND "task_id" = $2');
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("params[2]")).toBe("goat_task_1");
  });

  it("scopes goat.integrations to the authenticated WorkOS user", () => {
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL("https://goat.example.com/api/electric/v1/shape?table=goat.integrations"),
      userWorkosId: "user_123",
    });

    expect(url?.searchParams.get("table")).toBe("goat.integrations");
    expect(url?.searchParams.get("where")).toBe('"user_workos_id" = $1');
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("params[2]")).toBeNull();
  });

  it.each([
    "goat.brain_folders",
    "goat.brain_documents",
    "goat.brain_timeline_entries",
    "goat.brain_edges",
  ])("scopes %s to the route-authorized brain ref", (table) => {
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        `https://goat.example.com/api/electric/v1/shape?table=${table}&brain_ref=goat_brain_1&where=1=1`,
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
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://goat.example.com/api/electric/v1/shape?table=goat.brain_documents&brain_ref=goat_brain_1",
      ),
      userWorkosId: "user_123",
      ...(label.includes("mismatched") ? { authorizedBrainRef: "goat_brain_other" } : {}),
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
