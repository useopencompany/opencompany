import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createOpenApiDocument } from "../src/routes";

const target = fileURLToPath(new URL("../openapi/openapi.v1.json", import.meta.url));
const committed = await readFile(target, "utf8");
const generated = `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`;
if (committed !== generated) {
  throw new Error(
    "OpenAPI artifact is stale. Run bun --filter @opencompany/protocol openapi:generate.",
  );
}
