import { describe, expect, it } from "vitest";
import { MOCK_CATALOG_STATS } from "./catalog";
import { CatalogService } from "./catalog-service";
import { runSandbox } from "./sandbox";
import { BENCHMARK_TASKS } from "./tasks";

describe("code tool-interface experiment", () => {
  it("reuses the five-integration, one-hundred-tool comparison fixture", () => {
    expect(MOCK_CATALOG_STATS).toEqual({ integrations: 5, tools: 100 });
    expect(BENCHMARK_TASKS).toHaveLength(15);
  });

  it("ranks tools by integration and intent without returning schemas", () => {
    const catalog = new CatalogService();
    const results = catalog.search("post a Slack channel message", 3);
    expect(results[0]?.path).toBe("slack.send_message");
    expect(results[0]).not.toHaveProperty("inputSchema");
  });

  it("rejects malformed tool input at the mock integration boundary", async () => {
    const catalog = new CatalogService();
    await expect(catalog.invoke("slack.send_message", { channel: "#sales" })).rejects.toThrow(
      "missing required input: text",
    );
    expect(catalog.trace.at(-1)).toMatchObject({
      kind: "invoke_error",
      path: "slack.send_message",
    });
  });

  it("distinguishes schema validation from a seeded integration error", async () => {
    const catalog = new CatalogService();
    await expect(
      catalog.invoke("github.merge_pull_request", {
        owner: "opencompany",
        repo: "goat",
        pullNumber: 91,
        method: "squash",
      }),
    ).rejects.toThrow("branch protection requires the security-review check");
    expect(catalog.trace.at(-1)).toMatchObject({
      kind: "invoke_error",
      path: "github.merge_pull_request",
      errorKind: "tool_error",
    });
  });

  it("executes a multi-tool chain in one worker and captures the trace", async () => {
    const catalog = new CatalogService();
    const result = await runSandbox({
      catalog,
      code: `
        const matches = await tools.search("Linear issue search");
        const path = matches[0].path;
        await tools.describe(path);
        const issues = await tools[path]({ query: "OC-142" });
        const issue = issues.data[0];
        await tools.describe("slack.send_message");
        const posted = await tools["slack.send_message"]({
          channel: "#eng-triage",
          text: issue.identifier + ": " + issue.title,
        });
        return posted.data;
      `,
    });
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ channel: "#eng-triage" });
    expect(catalog.trace.map((event) => event.kind)).toEqual([
      "search",
      "describe",
      "invoke",
      "describe",
      "invoke",
    ]);
  });

  it("hard-stops non-terminating generated code", async () => {
    const result = await runSandbox({
      catalog: new CatalogService(),
      code: "while (true) {}",
      timeoutMs: 200,
    });
    expect(result).toMatchObject({ ok: false, failureKind: "timeout" });
  });
});
