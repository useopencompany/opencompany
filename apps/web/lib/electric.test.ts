import { describe, expect, it } from "vitest";
import { buildGoatElectricOriginUrl, hasInvalidElectricCloudSecretPair } from "@/lib/electric";

describe("buildGoatElectricOriginUrl", () => {
  it.each([
    "goat.tasks",
    "goat.task_schedules",
    "goat.chat_messages",
    "goat.chat_sessions",
    "goat.codex_chat_sessions",
    "goat.wiki_pages",
    "goat.brain_documents",
  ])("rejects the retired physical %s shape", (table) => {
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com/",
      requestUrl: new URL(`https://goat.example.com/api/electric/v1/shape?table=${table}`),
      userWorkosId: "user_123",
      workspaceId: "workspace_123",
    });

    expect(url).toBeNull();
  });

  it("rejects unknown tables", () => {
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL("https://goat.example.com/api/electric/v1/shape?table=users"),
      userWorkosId: "user_123",
    });

    expect(url).toBeNull();
  });

  it("scopes integrations to personal rows plus the active workspace", () => {
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL(
        "https://goat.example.com/api/electric/v1/shape?table=goat.integrations&live=true&where=1=1",
      ),
      userWorkosId: "user_123",
      workspaceId: "gws_123",
    });

    expect(url?.searchParams.get("table")).toBe("goat.integrations");
    expect(url?.searchParams.get("live")).toBe("true");
    expect(url?.searchParams.get("where")).toBe(
      '("user_workos_id" = $1 AND "workspace_id" IS NULL) OR "workspace_id" = $2',
    );
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("params[2]")).toBe("gws_123");
  });

  it("scopes integrations to personal rows without a workspace context", () => {
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL("https://goat.example.com/api/electric/v1/shape?table=integrations"),
      userWorkosId: "user_123",
    });

    expect(url?.searchParams.get("where")).toBe('"user_workos_id" = $1 AND "workspace_id" IS NULL');
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("params[2]")).toBeNull();
  });

  it("requires Electric Cloud source id and secret together", () => {
    expect(hasInvalidElectricCloudSecretPair({ sourceId: "source", sourceSecret: "" })).toBe(true);
    expect(hasInvalidElectricCloudSecretPair({ sourceId: "source", sourceSecret: "secret" })).toBe(
      false,
    );
  });
});
