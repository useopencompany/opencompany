import { afterEach, expect, it, vi } from "vitest";
import { DopplerAuthRejected, validateDopplerToken } from "./doppler-api";

afterEach(() => vi.unstubAllGlobals());
it("returns only identity, excluding token previews", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ name: "Development", token_preview: "sensitive" })),
  );
  expect(await validateDopplerToken("dp.ct.test")).toBe("Development");
});
it.each([401, 403])("recognizes rejected credentials (%s)", async (status) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("private detail", { status })),
  );
  await expect(validateDopplerToken("dp.ct.test")).rejects.toBeInstanceOf(DopplerAuthRejected);
});
it("distinguishes a temporary outage from credential rejection", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("private detail", { status: 503 })),
  );
  await expect(validateDopplerToken("dp.ct.test")).rejects.toThrow("Please try again");
});
it("rejects malformed identity responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ name: 42 })),
  );
  await expect(validateDopplerToken("dp.ct.test")).rejects.toThrow("invalid account response");
});
