import { describe, expect, it } from "vitest";
import { CatalogService } from "../code-tool-interface/catalog-service";
import { outstandingIntentGroups } from "./benchmark";
import { contractFor } from "./contracts";
import { discoverToolContracts } from "./discovery";
import { runProgressiveSandbox } from "./sandbox";

describe("progressive typed-code experiment", () => {
  it("loads complete typed contracts before code generation", () => {
    const catalog = new CatalogService();
    const result = discoverToolContracts(catalog, {
      queries: ["attio search company records", "attio update company record"],
      readCandidatesPerQuery: 1,
    });
    expect(result.loadedPaths).toEqual(["attio.search_records", "attio.update_record"]);
    expect(result.typeScriptDefinitions).toContain(
      '"object": string; /** Search text. */ "query": string',
    );
    expect(result.typeScriptDefinitions).toContain(
      '"recordId": string; /** Changed attribute values. */ "values": Record<string, unknown>',
    );
    expect(result.typeScriptDefinitions).toContain("ToolResult<AttioRecord[]>");
    expect(catalog.trace.filter((event) => event.kind === "describe")).toHaveLength(2);
  });

  it("defaults to one candidate and reranks rare intent terms", () => {
    const catalog = new CatalogService();
    const result = discoverToolContracts(catalog, {
      queries: ["github get pull request details", "github create pull request review"],
      readCandidatesPerQuery: 1,
    });
    expect(result.loadedPaths).toEqual(["github.get_pull_request", "github.create_review"]);
    expect(result.intents).toEqual([
      {
        query: "github get pull request details",
        effect: "read",
        candidatePaths: ["github.get_pull_request"],
      },
      {
        query: "github create pull request review",
        effect: "write",
        candidatePaths: ["github.create_review"],
      },
    ]);
  });

  it("keeps read collection verbs from resolving to similarly named writes", () => {
    const cases = [
      ["linear list issues in a team", "linear.list_issues"],
      ["linear list open issues by team", "linear.list_issues"],
      ["github list pull requests open by repo", "github.list_pull_requests"],
    ] as const;
    for (const [query, expectedPath] of cases) {
      const result = discoverToolContracts(new CatalogService(), {
        queries: [query],
        readCandidatesPerQuery: 1,
      });
      expect(result.loadedPaths).toEqual([expectedPath]);
      expect(result.intents[0]?.effect).toBe("read");
    }
  });

  it("maps safe write-action aliases without broadening write candidates", () => {
    const cases = [
      ["slack broadcast message", "slack.send_message"],
      ["slack notify channel", "slack.send_message"],
      ["github approve pull request review", "github.create_review"],
    ] as const;
    for (const [query, expectedPath] of cases) {
      const result = discoverToolContracts(new CatalogService(), {
        queries: [query],
      });
      expect(result.intents).toEqual([{ query, effect: "write", candidatePaths: [expectedPath] }]);
    }
  });

  it("returns a narrow safe candidate set for ambiguous read synonyms", () => {
    const result = discoverToolContracts(new CatalogService(), {
      queries: ["slack get thread replies"],
    });
    expect(result.intents[0]).toMatchObject({
      effect: "read",
      candidatePaths: expect.arrayContaining(["slack.fetch_thread"]),
    });
    expect(result.intents[0]?.candidatePaths).toHaveLength(2);
  });

  it("keeps required intent groups outstanding until a candidate is attempted", async () => {
    const catalog = new CatalogService();
    const discovery = discoverToolContracts(catalog, {
      queries: ["github get pull request", "github submit review"],
      readCandidatesPerQuery: 1,
    });
    expect(outstandingIntentGroups(discovery, catalog)).toHaveLength(2);
    await catalog.invoke("github.get_pull_request", {
      owner: "opencompany",
      repo: "goat",
      pullNumber: 42,
    });
    expect(outstandingIntentGroups(discovery, catalog)).toEqual([
      expect.objectContaining({
        candidatePaths: ["github.create_review"],
      }),
    ]);
  });

  it("executes only paths loaded by progressive discovery", async () => {
    const catalog = new CatalogService();
    const result = await runProgressiveSandbox({
      catalog,
      allowedPaths: new Set(["linear.search_issues"]),
      allowSideEffects: false,
      code: `
        const issues = await tools["linear.search_issues"]({ query: "OC-142" });
        return issues.data[0].title;
      `,
    });
    expect(result).toMatchObject({
      ok: true,
      value: "OAuth callback intermittently fails",
    });
    expect(result.policyTrace).toEqual([
      expect.objectContaining({
        path: "linear.search_issues",
        decision: "allow",
        effect: "read",
      }),
    ]);
  });

  it("blocks an unloaded path even when it exists in the catalog", async () => {
    const catalog = new CatalogService();
    const result = await runProgressiveSandbox({
      catalog,
      allowedPaths: new Set(["linear.search_issues"]),
      allowSideEffects: true,
      code: `return await tools["slack.send_message"]({ channel: "#sales", text: "no" });`,
    });
    expect(result).toMatchObject({ ok: false, failureKind: "policy" });
    expect(result.error).toContain("was not loaded");
    expect(catalog.mutations).toHaveLength(0);
  });

  it("blocks writes unless the host explicitly enables them", async () => {
    const result = await runProgressiveSandbox({
      catalog: new CatalogService(),
      allowedPaths: new Set(["slack.send_message"]),
      allowSideEffects: false,
      code: `return await tools["slack.send_message"]({ channel: "#sales", text: "no" });`,
    });
    expect(result).toMatchObject({ ok: false, failureKind: "policy" });
    expect(result.error).toContain("not approved");
  });

  it("classifies every non-allowlisted catalog verb as a write", () => {
    for (const path of [
      "slack.schedule_message",
      "slack.cancel_scheduled",
      "slack.upload_file",
      "github.rerun_workflow",
      "notion.append_blocks",
      "notion.move_page",
    ]) {
      expect(contractFor(path).effect).toBe("write");
    }
  });

  it("blocks less-obvious side effects inside execute", async () => {
    const result = await runProgressiveSandbox({
      catalog: new CatalogService(),
      allowedPaths: new Set(["slack.upload_file"]),
      allowSideEffects: false,
      code: `return await tools["slack.upload_file"]({ channelId: "CENG123", filename: "x.txt", content: "no" });`,
    });
    expect(result).toMatchObject({ ok: false, failureKind: "policy" });
    expect(result.error).toContain("not approved");
  });

  it("blocks duplicate writes within one execution", async () => {
    const catalog = new CatalogService();
    const result = await runProgressiveSandbox({
      catalog,
      allowedPaths: new Set(["slack.send_message"]),
      allowSideEffects: true,
      code: `
        await tools["slack.send_message"]({ channel: "#sales", text: "first" });
        return await tools["slack.send_message"]({ channel: "#sales", text: "second" });
      `,
    });
    expect(result).toMatchObject({ ok: false, failureKind: "policy" });
    expect(result.error).toContain("Duplicate write");
    expect(catalog.mutations).toHaveLength(1);
  });

  it("does not expose Node, network, or module-loading globals", async () => {
    const result = await runProgressiveSandbox({
      catalog: new CatalogService(),
      allowedPaths: new Set(["linear.search_issues"]),
      allowSideEffects: false,
      code: `return {
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        webSocket: typeof WebSocket,
      };`,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        process: "undefined",
        require: "undefined",
        fetch: "undefined",
        webSocket: "undefined",
      },
    });
  });

  it("blocks string-code generation and dynamic module imports", async () => {
    const catalog = new CatalogService();
    const constructorEscape = await runProgressiveSandbox({
      catalog,
      allowedPaths: new Set(["linear.search_issues"]),
      allowSideEffects: false,
      code: `return ({}).constructor.constructor("return process")();`,
    });
    expect(constructorEscape).toMatchObject({
      ok: false,
      failureKind: "runtime",
    });
    expect(constructorEscape.error).toContain("Code generation from strings disallowed");

    const dynamicImport = await runProgressiveSandbox({
      catalog,
      allowedPaths: new Set(["linear.search_issues"]),
      allowSideEffects: false,
      code: `return await import("node:fs");`,
    });
    expect(dynamicImport).toMatchObject({
      ok: false,
      failureKind: "runtime",
    });
  });

  it("enforces the per-execution tool-call budget", async () => {
    const result = await runProgressiveSandbox({
      catalog: new CatalogService(),
      allowedPaths: new Set(["linear.search_issues"]),
      allowSideEffects: false,
      maxToolCalls: 1,
      code: `
        await tools["linear.search_issues"]({ query: "first" });
        return await tools["linear.search_issues"]({ query: "second" });
      `,
    });
    expect(result).toMatchObject({
      ok: false,
      failureKind: "policy",
      invocationCount: 1,
    });
    expect(result.policyTrace).toContainEqual(
      expect.objectContaining({
        path: "linear.search_issues",
        decision: "deny",
      }),
    );
  });

  it("terminates synchronous runaway code", async () => {
    const result = await runProgressiveSandbox({
      catalog: new CatalogService(),
      allowedPaths: new Set(["linear.search_issues"]),
      allowSideEffects: false,
      timeoutMs: 150,
      code: `while (true) {}`,
    });
    expect(result).toMatchObject({ ok: false, failureKind: "timeout" });
  });

  it("bounds and serializes sandbox logs", async () => {
    const result = await runProgressiveSandbox({
      catalog: new CatalogService(),
      allowedPaths: new Set(["linear.search_issues"]),
      allowSideEffects: false,
      code: `
        const cyclic = {};
        cyclic.self = cyclic;
        console.log("x".repeat(5_000), cyclic);
        return true;
      `,
    });
    expect(result).toMatchObject({ ok: true, value: true });
    expect(result.logs).toHaveLength(1);
    expect(String(result.logs[0]?.values[0])).toHaveLength(2_001);
    expect(result.logs[0]?.values[1]).toBe("[object Object]");
  });
});
