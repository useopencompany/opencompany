import { describe, expect, it } from "vitest";
import { headlessApiRouting } from "./headless-api-routing.mjs";

const credentialedOrigin = new URL("https://api.test");
credentialedOrigin.username = "user";
credentialedOrigin.password = "pass";

describe("headless API routing", () => {
  it("routes the complete versioned path through an uncached external rewrite", () => {
    expect(headlessApiRouting("https://api.example.test", ["https://app.example.test"])).toEqual({
      headers: [
        {
          source: "/v1/:path*",
          headers: [{ key: "x-vercel-enable-rewrite-caching", value: "0" }],
        },
      ],
      rewrites: [
        {
          source: "/v1/:path*",
          destination: "https://api.example.test/v1/:path*",
        },
      ],
    });
  });

  it("uses only the configured origin", () => {
    expect(
      headlessApiRouting("https://api.example.test/private/path?token=nope", []).rewrites,
    ).toEqual([{ source: "/v1/:path*", destination: "https://api.example.test/v1/:path*" }]);
  });

  it.each([undefined, "", "not a URL", "ftp://api.example.test", credentialedOrigin.toString()])(
    "leaves the fail-closed route active for invalid origin %s",
    (origin) => {
      expect(headlessApiRouting(origin, [])).toEqual({ headers: [], rewrites: [] });
    },
  );

  it.each([
    ["https://app.example.test", "https://app.example.test"],
    ["https://app.example.test", "app.example.test"],
  ])("rejects a same-origin rewrite from %s and %s", (apiOrigin, webOrigin) => {
    expect(headlessApiRouting(apiOrigin, [webOrigin])).toEqual({ headers: [], rewrites: [] });
  });
});
