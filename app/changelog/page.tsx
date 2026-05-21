import { promises as fs } from "node:fs";
import path from "node:path";

import Sidebar from "@/components/Sidebar";
import ChangelogView from "@/components/ChangelogView";
import { parseChangelog } from "@/lib/changelog";

export const dynamic = "force-static";

export default async function ChangelogPage() {
  const filePath = path.join(process.cwd(), "CHANGELOG.md");
  const source = await fs.readFile(filePath, "utf8");
  const changelog = parseChangelog(source);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas">
      <Sidebar />
      <ChangelogView changelog={changelog} />
    </div>
  );
}
