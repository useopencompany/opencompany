import { describe, expect, it, vi } from "vitest";
import {
  cancelBrainImport,
  cancelWikiImport,
  confirmBrainImport,
  confirmWikiImport,
  matchesBrainImportSelectedScope,
  normalizeCompanyUrl,
  rankStoredBrainImportCandidate,
  retryBrainImportDiscovery,
  retryWikiImportDiscovery,
} from "./brain-import";

describe("confirmBrainImport", () => {
  it("uses one atomic statement instead of an interactive transaction", async () => {
    const execute = vi.fn(async () => [{ importRunId: "gbimp_123", enqueued: 1 }]);
    const transaction = vi.fn(() => {
      throw new Error("No transactions support in neon-http driver");
    });

    await expect(
      confirmBrainImport({
        importRunId: "gbimp_123",
        brainRef: "gbrain_123",
        enabledProviders: ["public_web"],
        actingUserWorkosId: "user_123",
        db: { execute, transaction },
      }),
    ).resolves.toEqual({ importRunId: "gbimp_123", enqueued: 1 });

    expect(execute).toHaveBeenCalledOnce();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("cancelBrainImport", () => {
  it("atomically cancels the run without an interactive transaction", async () => {
    const execute = vi.fn(async () => [{ importRunId: "gbimp_123", skippedJobs: 2 }]);
    const transaction = vi.fn(() => {
      throw new Error("No transactions support in neon-http driver");
    });

    await expect(
      cancelBrainImport({
        importRunId: "gbimp_123",
        brainRef: "gbrain_123",
        db: { execute, transaction },
      }),
    ).resolves.toEqual({ importRunId: "gbimp_123", skippedJobs: 2 });

    expect(execute).toHaveBeenCalledOnce();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("retryBrainImportDiscovery", () => {
  it("atomically resets discovery without an interactive transaction", async () => {
    const execute = vi.fn(async () => [{ importRunId: "gbimp_123", deletedCandidates: 3 }]);
    const transaction = vi.fn(() => {
      throw new Error("No transactions support in neon-http driver");
    });

    await expect(
      retryBrainImportDiscovery({
        importRunId: "gbimp_123",
        brainRef: "gbrain_123",
        db: { execute, transaction },
      }),
    ).resolves.toEqual({ importRunId: "gbimp_123", deletedCandidates: 3 });

    expect(execute).toHaveBeenCalledOnce();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("Wiki import lifecycle commands", () => {
  it("confirms, cancels, and retries through workspace-scoped atomic statements", async () => {
    const transaction = vi.fn(() => {
      throw new Error("No transactions support in neon-http driver");
    });
    const confirmExecute = vi.fn(async () => [{ importRunId: "gbimp_wiki", enqueued: 0 }]);
    const cancelExecute = vi.fn(async () => [{ importRunId: "gbimp_wiki", skippedJobs: 2 }]);
    const retryExecute = vi.fn(async () => [{ importRunId: "gbimp_wiki", deletedCandidates: 3 }]);

    await expect(
      confirmWikiImport({
        importRunId: "gbimp_wiki",
        workspaceId: "workspace_1",
        enabledProviders: ["public_web"],
        actingUserWorkosId: "user_1",
        db: { execute: confirmExecute, transaction },
      }),
    ).resolves.toEqual({ importRunId: "gbimp_wiki", enqueued: 0 });
    await expect(
      cancelWikiImport({
        importRunId: "gbimp_wiki",
        workspaceId: "workspace_1",
        db: { execute: cancelExecute, transaction },
      }),
    ).resolves.toEqual({ importRunId: "gbimp_wiki", skippedJobs: 2 });
    await expect(
      retryWikiImportDiscovery({
        importRunId: "gbimp_wiki",
        workspaceId: "workspace_1",
        db: { execute: retryExecute, transaction },
      }),
    ).resolves.toEqual({ importRunId: "gbimp_wiki", deletedCandidates: 3 });

    expect(confirmExecute).toHaveBeenCalledOnce();
    expect(cancelExecute).toHaveBeenCalledOnce();
    expect(retryExecute).toHaveBeenCalledOnce();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("normalizeCompanyUrl", () => {
  it("canonicalizes a public company origin", () => {
    expect(normalizeCompanyUrl("https://Example.COM/about?utm_source=test#team")).toEqual({
      url: "https://example.com",
      domain: "example.com",
    });
    expect(normalizeCompanyUrl("example.com")).toEqual({
      url: "https://example.com",
      domain: "example.com",
    });
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1",
    "http://10.0.0.1",
    "http://172.16.0.1",
    "http://169.254.1.1",
    "http://192.168.1.2",
    "http://[::1]",
    "http://[fc00::1]",
    "http://[::ffff:127.0.0.1]",
    "http://[::ffff:169.254.169.254]",
    "file:///etc/passwd",
    "https://user:secret@example.com",
  ])("rejects non-public input %s", (value) => {
    expect(() => normalizeCompanyUrl(value)).toThrow();
  });
});

describe("Granola context import", () => {
  const granolaItem = {
    content: {
      meeting: {
        summaryMarkdown: "Decided to ship the new onboarding flow.",
        transcript: [{ text: "We should launch on Monday." }],
      },
    },
  };

  it("accepts connected Granola notes without provider-specific scope filters", () => {
    expect(matchesBrainImportSelectedScope("granola", granolaItem, {})).toBe(true);
  });

  it("ranks substantive Granola notes as import candidates", () => {
    expect(rankStoredBrainImportCandidate("granola", granolaItem)).toBeGreaterThan(100);
    expect(
      rankStoredBrainImportCandidate("granola", {
        content: { meeting: { summaryMarkdown: "", transcript: [] } },
      }),
    ).toBe(Number.NEGATIVE_INFINITY);
  });
});
