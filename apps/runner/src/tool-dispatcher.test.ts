import type { AgentBrainReference } from "@opencompany/agent-runtime";
import { describe, expect, it } from "vitest";
import {
  formatRuntimePreview,
  preflightSandboxToolArgs,
  redactPreviewSecrets,
} from "./tool-dispatcher";

const WORKDIR = "/home/user/workspace";
const WIKI_ONLY: AgentBrainReference[] = [{ path: "wiki/", type: "folder" }];

describe("preflightSandboxToolArgs brain scope", () => {
  it("allows writes inside a mounted brain folder, including new files", () => {
    expect(() =>
      preflightSandboxToolArgs({
        name: "write_file",
        args: { path: "brain/wiki/new.md", content: "hi" },
        workdir: WORKDIR,
        brainReferences: WIKI_ONLY,
      }),
    ).not.toThrow();
  });

  it("rejects writes outside the mounted brain scope with a guiding message", () => {
    expect(() =>
      preflightSandboxToolArgs({
        name: "write_file",
        args: { path: "brain/marketing/plan.md", content: "hi" },
        workdir: WORKDIR,
        brainReferences: WIKI_ONLY,
      }),
    ).toThrow(/outside this agent's mounted Brain access.*brain\/wiki\/.*self-edit/s);
  });

  it("rejects reads outside the mounted brain scope", () => {
    expect(() =>
      preflightSandboxToolArgs({
        name: "read_file",
        args: { path: "brain/marketing/plan.md" },
        workdir: WORKDIR,
        brainReferences: WIKI_ONLY,
      }),
    ).toThrow(/brain\/marketing\/plan\.md is outside/);
  });

  it("rejects edits when the agent has no brain access", () => {
    expect(() =>
      preflightSandboxToolArgs({
        name: "edit_file",
        args: { path: "brain/wiki/page.md" },
        workdir: WORKDIR,
        brainReferences: [],
      }),
    ).toThrow(/this agent has no mounted Brain paths/);
  });

  it("allows listing the brain root and ancestors but not out-of-scope folders", () => {
    expect(() =>
      preflightSandboxToolArgs({
        name: "list_files",
        args: { path: "brain" },
        workdir: WORKDIR,
        brainReferences: WIKI_ONLY,
      }),
    ).not.toThrow();
    expect(() =>
      preflightSandboxToolArgs({
        name: "list_files",
        args: { path: "brain/wiki" },
        workdir: WORKDIR,
        brainReferences: WIKI_ONLY,
      }),
    ).not.toThrow();
    expect(() =>
      preflightSandboxToolArgs({
        name: "list_files",
        args: { path: "brain/marketing" },
        workdir: WORKDIR,
        brainReferences: WIKI_ONLY,
      }),
    ).toThrow(/outside this agent/);
  });

  it("does not constrain work/ and agent/ paths by brain scope", () => {
    for (const path of ["work/foo.txt", "agent/memory.md"]) {
      expect(() =>
        preflightSandboxToolArgs({
          name: "write_file",
          args: { path, content: "x" },
          workdir: WORKDIR,
          brainReferences: [],
        }),
      ).not.toThrow();
    }
  });

  it("rejects personal memory/ paths for generic file tools with a memory-tool hint", () => {
    for (const name of ["read_file", "write_file", "edit_file", "list_files"] as const) {
      expect(() =>
        preflightSandboxToolArgs({
          name,
          args: { path: "memory/profile.md" },
          workdir: WORKDIR,
          brainReferences: [],
          personal: true,
        }),
      ).toThrow(/Generic file tools cannot access memory\/\. Use the memory tool/);
    }
  });
});

// ---------------------------------------------------------------------------
// redactPreviewSecrets
// ---------------------------------------------------------------------------
// These tests reproduce the class of leak where a tool output preview contained
// a raw secret (e.g. a PostHog project API key returned by the PostHog MCP
// server) and was persisted verbatim to agent_session_events.payload.outputPreview.
// ---------------------------------------------------------------------------

describe("redactPreviewSecrets", () => {
  it("redacts a PostHog phc_ project API key embedded in plain text", () => {
    const leaked = "Your PostHog project API key is phc_AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    expect(redactPreviewSecrets(leaked)).toBe("Your PostHog project API key is [redacted]");
  });

  it("redacts a PostHog phc_ key when it appears in a JSON-like value", () => {
    const leaked = '{"project_api_key": "phc_XYZabcdefghijklmnopqrstuvwxyz0123456789"}';
    const result = redactPreviewSecrets(leaked);
    expect(result).not.toContain("phc_");
    expect(result).toContain("[redacted]");
  });

  it("redacts a Bearer authorization token", () => {
    const leaked = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig";
    expect(redactPreviewSecrets(leaked)).toBe("Authorization: Bearer [redacted]");
  });

  it("redacts a Basic authorization token", () => {
    const leaked = "Authorization: Basic dXNlcjpwYXNzd29yZA==";
    expect(redactPreviewSecrets(leaked)).toBe("Authorization: Basic [redacted]");
  });

  it("redacts api_key=value credential pairs", () => {
    expect(redactPreviewSecrets("api_key=supersecret123")).toBe("api_key=[redacted]");
    expect(redactPreviewSecrets("api-key=supersecret123")).toBe("api-key=[redacted]");
  });

  it("redacts token= and secret= credential pairs", () => {
    expect(redactPreviewSecrets("token=my_secret_token")).toBe("token=[redacted]");
    expect(redactPreviewSecrets("secret=my_secret_value")).toBe("secret=[redacted]");
  });

  it("redacts password= credential pairs", () => {
    expect(redactPreviewSecrets("password=hunter2")).toBe("password=[redacted]");
  });

  it("redacts an OpenAI-style sk- secret key", () => {
    const leaked = "sk-abcdefghijklmnopqrstuvwxyz";
    expect(redactPreviewSecrets(leaked)).toBe("[redacted]");
  });

  it("does not redact a short sk- token below the minimum length", () => {
    // sk- + 11 chars = 14 total, but min is sk- + 12 = 15
    const short = "sk-tooshort";
    expect(redactPreviewSecrets(short)).toBe("sk-tooshort");
  });

  it("redacts a GitHub personal access token (ghp_ prefix)", () => {
    const leaked = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    expect(redactPreviewSecrets(leaked)).toBe("[redacted]");
  });

  it("redacts a GitHub server token (ghs_ prefix)", () => {
    const leaked = "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    expect(redactPreviewSecrets(leaked)).toBe("[redacted]");
  });

  it("redacts a fine-grained GitHub PAT (github_pat_ prefix)", () => {
    const leaked = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_xyz";
    expect(redactPreviewSecrets(leaked)).toBe("[redacted]");
  });

  it("redacts multiple secrets in the same string", () => {
    const leaked = "api_key=abc123xyz&token=def456uvw Bearer some_bearer_token_value_here";
    const result = redactPreviewSecrets(leaked);
    expect(result).not.toContain("abc123xyz");
    expect(result).not.toContain("def456uvw");
    expect(result).not.toContain("some_bearer_token_value_here");
    expect(result).toContain("[redacted]");
  });

  it("leaves safe content unchanged", () => {
    expect(redactPreviewSecrets("Query executed successfully. 42 rows returned.")).toBe(
      "Query executed successfully. 42 rows returned.",
    );
  });

  it("handles an empty string", () => {
    expect(redactPreviewSecrets("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// formatRuntimePreview — regression for the outputPreview leak
// ---------------------------------------------------------------------------

describe("formatRuntimePreview", () => {
  it("redacts a PostHog API key appearing in a tool output string (leak regression)", () => {
    // Simulates what the PostHog MCP server might return — a response that
    // embeds the project API key. Before the fix this was persisted verbatim.
    const mcpOutput = "Project API key: phc_AbCdEfGhIjKlMnOpQrStUvWxYz012345, project_id: 12345";
    const preview = formatRuntimePreview(mcpOutput);
    expect(preview).not.toContain("phc_");
    expect(preview).toContain("[redacted]");
  });

  it("redacts a PostHog API key appearing in a JSON tool output object (leak regression)", () => {
    // Simulates an MCP JSON response that includes the project API key field.
    const mcpOutput = {
      project_api_key: "phc_AbCdEfGhIjKlMnOpQrStUvWxYz012345",
      project_id: 12345,
      name: "My Project",
    };
    const preview = formatRuntimePreview(mcpOutput);
    expect(preview).not.toContain("phc_AbCdEfGhIjKlMnOpQrStUvWxYz012345");
    expect(preview).toContain("[redacted]");
  });

  it("redacts a Bearer token in a tool output string", () => {
    const output = "Response headers: Authorization: Bearer eyABC.DEF.GHI";
    const preview = formatRuntimePreview(output);
    expect(preview).not.toContain("eyABC.DEF.GHI");
    expect(preview).toContain("Bearer [redacted]");
  });

  it("truncates long output to 900 chars and still redacts secrets in the retained portion", () => {
    const secret = "phc_AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    // Place the secret at the start so it is inside the retained 900-char window
    const longOutput = secret + " " + "x".repeat(1000);
    const preview = formatRuntimePreview(longOutput);
    expect(preview.length).toBeLessThanOrEqual(900);
    expect(preview).not.toContain("phc_");
    expect(preview).toContain("[redacted]");
  });

  it("returns empty string for null input", () => {
    expect(formatRuntimePreview(null)).toBe("");
  });

  it("returns empty string for undefined input", () => {
    expect(formatRuntimePreview(undefined)).toBe("");
  });

  it("leaves safe string output unchanged", () => {
    expect(formatRuntimePreview("query returned 5 results")).toBe("query returned 5 results");
  });

  it("leaves safe object output unchanged", () => {
    const output = { results: [{ id: 1, name: "foo" }], count: 1 };
    const preview = formatRuntimePreview(output);
    expect(preview).toContain('"foo"');
    expect(preview).toContain('"count": 1');
  });
});
