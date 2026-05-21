import { promises as fs } from "node:fs";
import path from "node:path";

import AppShell from "@/components/AppShell";
import ChangelogView from "@/components/ChangelogView";
import { parseChangelog } from "@/lib/changelog";

// Render at build time so the file read uses build-time cwd (apps/web) and the
// result is baked into static HTML. Avoids depending on CHANGELOG.md being
// present in the serverless bundle at runtime.
export const dynamic = "force-static";

export default async function ChangelogPage() {
  const filePath = path.resolve(process.cwd(), "..", "..", "CHANGELOG.md");
  const source = await fs.readFile(filePath, "utf8");
  const changelog = parseChangelog(source);

  return (
    <AppShell>
      <ChangelogView changelog={changelog} />
    </AppShell>
  );
}
