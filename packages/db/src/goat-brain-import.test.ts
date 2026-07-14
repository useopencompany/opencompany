import { describe, expect, it, vi } from "vitest";
import {
  cancelGoatBrainImport,
  confirmGoatBrainImport,
  normalizeGoatCompanyUrl,
  retryGoatBrainImportDiscovery,
} from "./goat-brain-import";

describe("confirmGoatBrainImport", () => {
  it("uses one atomic statement instead of an interactive transaction", async () => {
    const execute = vi.fn(async () => [{ importRunId: "gbimp_123", enqueued: 1 }]);
    const transaction = vi.fn(() => {
      throw new Error("No transactions support in neon-http driver");
    });

    await expect(
      confirmGoatBrainImport({
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

describe("cancelGoatBrainImport", () => {
  it("atomically cancels the run without an interactive transaction", async () => {
    const execute = vi.fn(async () => [{ importRunId: "gbimp_123", skippedJobs: 2 }]);
    const transaction = vi.fn(() => {
      throw new Error("No transactions support in neon-http driver");
    });

    await expect(
      cancelGoatBrainImport({
        importRunId: "gbimp_123",
        brainRef: "gbrain_123",
        db: { execute, transaction },
      }),
    ).resolves.toEqual({ importRunId: "gbimp_123", skippedJobs: 2 });

    expect(execute).toHaveBeenCalledOnce();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("retryGoatBrainImportDiscovery", () => {
  it("atomically resets discovery without an interactive transaction", async () => {
    const execute = vi.fn(async () => [{ importRunId: "gbimp_123", deletedCandidates: 3 }]);
    const transaction = vi.fn(() => {
      throw new Error("No transactions support in neon-http driver");
    });

    await expect(
      retryGoatBrainImportDiscovery({
        importRunId: "gbimp_123",
        brainRef: "gbrain_123",
        db: { execute, transaction },
      }),
    ).resolves.toEqual({ importRunId: "gbimp_123", deletedCandidates: 3 });

    expect(execute).toHaveBeenCalledOnce();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("normalizeGoatCompanyUrl", () => {
  it("canonicalizes a public company origin", () => {
    expect(normalizeGoatCompanyUrl("https://Example.COM/about?utm_source=test#team")).toEqual({
      url: "https://example.com",
      domain: "example.com",
    });
    expect(normalizeGoatCompanyUrl("example.com")).toEqual({
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
    expect(() => normalizeGoatCompanyUrl(value)).toThrow();
  });
});
