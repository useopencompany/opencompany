import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createOpenApiDocument } from "../src/routes";

const target = fileURLToPath(new URL("../openapi/openapi.v1.json", import.meta.url));
await writeFile(target, `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`, "utf8");
