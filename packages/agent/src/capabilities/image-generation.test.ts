import { calculatePlatformFeeUsdMicros } from "@opencompany/billing";
import { describe, expect, it } from "vitest";
import { imageGenerationCost, imageGenerationPrompt } from "./image-generation";

describe("managed AI image generation", () => {
  it("builds an image-to-image prompt with the exact reference bytes", () => {
    const reference = new Uint8Array([137, 80, 78, 71]);

    expect(imageGenerationPrompt("Restyle this technical diagram.", reference)).toEqual({
      text: "Restyle this technical diagram.",
      images: [reference],
    });
    expect(imageGenerationPrompt("Create a technical diagram.")).toBe(
      "Create a technical diagram.",
    );
  });

  it("uses the AI Gateway reported cost for settlement", () => {
    const providerCostUsdMicros = 40_000;

    expect(
      imageGenerationCost({
        gateway: { cost: "0.04", generationId: "generation_123" },
      } as unknown as Parameters<typeof imageGenerationCost>[0]),
    ).toEqual({
      providerCostUsdMicros,
      platformFeeUsdMicros: calculatePlatformFeeUsdMicros(providerCostUsdMicros),
      totalCostUsdMicros:
        providerCostUsdMicros + calculatePlatformFeeUsdMicros(providerCostUsdMicros),
      generationId: "generation_123",
    });
  });

  it("rejects missing, negative, and malformed Gateway costs", () => {
    expect(imageGenerationCost({})).toBeNull();
    expect(
      imageGenerationCost({
        gateway: { cost: "-0.01" },
      } as unknown as Parameters<typeof imageGenerationCost>[0]),
    ).toBeNull();
    expect(
      imageGenerationCost({
        gateway: { cost: "unknown" },
      } as unknown as Parameters<typeof imageGenerationCost>[0]),
    ).toBeNull();
  });
});
