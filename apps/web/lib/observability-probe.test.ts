import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isObservabilityProbeAuthorized } from "./observability-probe";

describe("isObservabilityProbeAuthorized", () => {
  it("accepts only an exact bearer secret", () => {
    expect(isObservabilityProbeAuthorized("Bearer cron-secret", "cron-secret")).toBe(true);
    expect(isObservabilityProbeAuthorized("Bearer wrong-secret", "cron-secret")).toBe(false);
    expect(isObservabilityProbeAuthorized("cron-secret", "cron-secret")).toBe(false);
  });

  it("fails closed when the secret is not configured", () => {
    expect(isObservabilityProbeAuthorized("Bearer cron-secret", undefined)).toBe(false);
    expect(isObservabilityProbeAuthorized(null, "cron-secret")).toBe(false);
  });
});
