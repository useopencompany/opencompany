import { promises as fs } from "node:fs";
import path from "node:path";

import AppShell from "@/components/AppShell";
import ChangelogView from "@/components/ChangelogView";
import { parseChangelog } from "@/lib/changelog";

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
