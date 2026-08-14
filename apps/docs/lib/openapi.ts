import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { OpenAPIV3_2 } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";

export const protocolOpenApiPath = resolve(
  process.cwd(),
  "../../packages/protocol/openapi/openapi.v1.json",
);

export const openapi = createOpenAPI({
  input: {
    "opencompany-v1": async () => {
      const document: OpenAPIV3_2.Document = JSON.parse(
        await readFile(protocolOpenApiPath, "utf8"),
      );

      // The protocol is served from the product origin today. The docs site may be
      // deployed separately, so absolute examples must not target the docs host.
      return {
        ...document,
        servers: [
          {
            url: "https://api.opencompany.chat",
            description: "opencompany production API",
          },
        ],
      };
    },
  },
});
