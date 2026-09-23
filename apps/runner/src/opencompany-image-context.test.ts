import type { FilePart } from "ai";
import { describe, expect, it } from "vitest";
import { estimateImageContextTokens, isContextImage } from "./opencompany-image-context";

// Dimension parsing only requires the PNG signature and IHDR header; no image is decoded.
function png(width: number, height: number, bytes = 33) {
  const data = Buffer.alloc(bytes);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(data);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function image(width: number, height: number, detail?: string): FilePart {
  return {
    type: "file",
    mediaType: "image/png",
    data: { type: "data", data: png(width, height) },
    ...(detail ? { providerOptions: { openai: { imageDetail: detail } } } : {}),
  };
}

describe("image context budgets", () => {
  it.each([
    [1024, 1024, 1229],
    [2048, 2048, 3000],
    [4096, 512, 2458],
  ])("matches OpenAI's documented high-detail example %ix%i", (width, height, tokens) => {
    expect(estimateImageContextTokens(image(width, height, "high"), "openai/gpt-6-astra")).toBe(
      tokens,
    );
  });

  it("resolves each model's default detail and bounds images that providers downscale", () => {
    expect(estimateImageContextTokens(image(4000, 4000), "openai/gpt-5.5")).toBe(12000);
    expect(estimateImageContextTokens(image(4000, 4000, "auto"), "openai/gpt-5.5")).toBe(12000);
    expect(estimateImageContextTokens(image(4000, 4000, "high"), "openai/gpt-5.5")).toBe(3000);
    expect(estimateImageContextTokens(image(4000, 4000, "low"), "openai/gpt-5.5")).toBe(308);
    expect(estimateImageContextTokens(image(4000, 4000), "openai/gpt-5.4-mini")).toBe(3000);
    expect(estimateImageContextTokens(image(4000, 4000), "openai/gpt-5.6-sol")).toBe(18750);
  });

  it("rejects the documented non-resizing patch limit instead of undercounting", () => {
    expect(() => estimateImageContextTokens(image(6000, 6000), "openai/gpt-6-astra")).toThrow(
      "supported image dimensions",
    );
    expect(estimateImageContextTokens(image(6000, 6000, "high"), "openai/gpt-6-astra")).toBe(3000);
  });

  it.each([
    [200, 200, 64],
    [1000, 1000, 1296],
    [1920, 1080, 2691],
    [3840, 2160, 4784],
  ])("matches Claude's documented high-resolution example %ix%i", (width, height, tokens) => {
    expect(estimateImageContextTokens(image(width, height), "anthropic/claude-opus-5.5")).toBe(
      tokens,
    );
  });

  it("distinguishes Claude resolution tiers", () => {
    expect(estimateImageContextTokens(image(1920, 1080), "anthropic/claude-sonnet-4.6")).toBe(1568);
    expect(estimateImageContextTokens(image(1920, 1080), "anthropic/claude-opus-4.7")).toBe(2691);
  });

  it("uses dimensions regardless of compression size or local transport representation", () => {
    const data = png(1024, 1024, 1_147_181);
    const transports: FilePart["data"][] = [
      data,
      data.toString("base64"),
      new URL(`data:image/png;base64,${data.toString("base64")}`),
      { type: "data", data },
      { type: "data", data: new Uint8Array(data) },
      { type: "data", data: new Uint8Array(data).buffer },
      { type: "data", data: data.toString("base64") },
      { type: "url", url: new URL(`data:image/png;base64,${data.toString("base64")}`) },
    ];
    for (const transport of transports) {
      expect(
        estimateImageContextTokens({ ...image(1, 1), data: transport }, "openai/gpt-5.5"),
      ).toBe(1229);
    }
    expect(estimateImageContextTokens(image(1024, 1024), "openai/gpt-5.5")).toBe(1229);
  });

  it("handles other supported raster headers", () => {
    const gif = Buffer.from("GIF89a0000");
    gif.writeUInt16LE(200, 6);
    gif.writeUInt16LE(200, 8);
    const jpeg = Buffer.from("ffd8ffc000110800c800c803012200021101031101ffd9", "hex");
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0);
    webp.writeUInt32LE(22, 4);
    webp.writeUInt32LE(10, 16);
    webp.write("WEBPVP8X", 8);
    webp.writeUIntLE(199, 24, 3);
    webp.writeUIntLE(199, 27, 3);
    for (const data of [gif, jpeg, webp]) {
      expect(
        estimateImageContextTokens(
          { ...image(1, 1), data: { type: "data", data } },
          "anthropic/claude-opus-5",
        ),
      ).toBe(64);
    }
  });

  it("reserves the known maximum for opaque, remote, or malformed images without fetching", () => {
    const transports: FilePart["data"][] = [
      { type: "url", url: new URL("https://must-not-fetch.invalid/image.png") },
      { type: "reference", reference: { openai: "file_image" } },
      { type: "data", data: Buffer.from("89504e470d0a1a0a", "hex") },
      { type: "data", data: Buffer.from("ffd8ff", "hex") },
      { type: "data", data: png(0, 0) },
      { type: "data", data: "not base64" },
    ];
    for (const data of transports) {
      expect(estimateImageContextTokens({ ...image(1, 1), data }, "openai/gpt-5.5")).toBe(12000);
    }
    expect(estimateImageContextTokens(image(1, 1), "unverified/model")).toBe(40000);
    expect(isContextImage({ type: "file", mediaType: "image" })).toBe(true);
    expect(isContextImage({ type: "file", mediaType: "application/pdf" })).toBe(false);
    expect(isContextImage({ type: "tool-result", mediaType: "image/png" })).toBe(false);
  });
});
