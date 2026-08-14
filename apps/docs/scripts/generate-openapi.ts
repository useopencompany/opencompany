import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateFilesOnly } from "fumadocs-openapi";
import { openapi } from "../lib/openapi";

const apiReferenceRoot = fileURLToPath(new URL("../content/docs/api-reference", import.meta.url));
const output = resolve(apiReferenceRoot, "endpoints");

if (dirname(output) !== apiReferenceRoot || relative(apiReferenceRoot, output) !== "endpoints") {
  throw new Error(`Refusing to replace unexpected OpenAPI output path: ${output}`);
}

const generated = await generateFilesOnly({
  input: openapi,
  per: "operation",
  groupBy: (entry) => {
    const tags = "tags" in entry.item ? entry.item.tags : undefined;
    return Array.isArray(tags) && typeof tags[0] === "string" ? tags[0] : "Other";
  },
  meta: true,
  includeDescription: true,
  addGeneratedComment:
    "Generated from packages/protocol/openapi/openapi.v1.json by bun run generate:openapi. Do not edit.",
});

await rm(output, { recursive: true, force: true });

for (const file of generated) {
  const target = resolve(output, file.path);
  const targetRelativePath = relative(output, target);
  if (targetRelativePath.startsWith("..") || targetRelativePath === "") {
    throw new Error(`Refusing to write unexpected OpenAPI output file: ${target}`);
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, file.content);
}

const operationCount = generated.filter((file) => file.path.endsWith(".mdx")).length;
console.log(`Generated ${operationCount} OpenAPI operation pages in ${output}`);
