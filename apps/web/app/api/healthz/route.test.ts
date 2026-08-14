import { PROTOCOL_VERSION } from "@opencompany/protocol";
import { expect, it } from "vitest";
import { GET } from "./route";

it("reports the browser protocol version", async () => {
  await expect(GET().json()).resolves.toMatchObject({
    ok: true,
    service: "opencompany-goat",
    protocolVersion: PROTOCOL_VERSION,
  });
});
