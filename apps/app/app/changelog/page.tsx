import { promises as fs } from "node:fs";
import path from "node:path";

import type { Metadata } from "next";

import ChangelogView from "@/components/ChangelogView";
import { parseChangelog } from "@/lib/changelog";

// The changelog is authored by hand in the repo-root CHANGELOG.md (Keep a
// Changelog 1.1.0 format) and read at build time, so a deploy publishes the
// latest entries as static HTML. `/changelog` is allow-listed in proxy.ts so
// it is reachable without a session.
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Changelog - Goat",
  description: "Notable changes to Goat, in Keep a Changelog format.",
};

export default async function ChangelogPage() {
  const filePath = path.resolve(process.cwd(), "..", "..", "CHANGELOG.md");
  const source = await fs.readFile(filePath, "utf8");
  const changelog = parseChangelog(source);

  return <ChangelogView changelog={changelog} />;
}
