import { describe, expect, it } from "vitest";
import { buildGoatElectricOriginUrl, hasInvalidElectricCloudSecretPair } from "@/lib/electric";

describe("buildGoatElectricOriginUrl", () => {
  it("scopes goat.tasks to the authenticated WorkOS user", () => {
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com/",
      requestUrl: new URL(
        "https://goat.example.com/api/electric/v1/shape?table=goat.tasks&live=true&where=1=1",
      ),
      userWorkosId: "user_123",
    });

    expect(url).not.toBeNull();
    expect(url?.origin).toBe("https://electric.example.com");
    expect(url?.pathname).toBe("/v1/shape");
    expect(url?.searchParams.get("table")).toBe("goat.tasks");
    expect(url?.searchParams.get("where")).toBe('"user_workos_id" = $1');
    expect(url?.searchParams.get("params[1]")).toBe("user_123");
    expect(url?.searchParams.get("live")).toBe("true");
    expect(url?.searchParams.get("where")).not.toBe("1=1");
  });

  it("rejects unknown tables", () => {
    const url = buildGoatElectricOriginUrl({
      electricUrl: "https://electric.example.com",
      requestUrl: new URL("https://goat.example.com/api/electric/v1/shape?table=users"),
      userWorkosId: "user_123",
    });

    expect(url).toBeNull();
  });

  it("requires Electric Cloud source id and secret together", () => {
    expect(hasInvalidElectricCloudSecretPair({ sourceId: "source", sourceSecret: "" })).toBe(true);
    expect(hasInvalidElectricCloudSecretPair({ sourceId: "source", sourceSecret: "secret" })).toBe(
      false,
    );
  });
});
