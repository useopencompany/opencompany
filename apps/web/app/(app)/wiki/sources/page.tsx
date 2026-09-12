import { notFound } from "next/navigation";
import { WikiSourcesPanel } from "@/components/WikiSourcesPanel";
import { currentUser } from "@/lib/auth";
import { listHeadlessWikis } from "@/lib/headless-knowledge-server";

export default async function WikiSourcesPage() {
  const { workspace, role } = await currentUser();
  // Ingestion only ever writes to the default wiki, so that is where this page's
  // "Back to Wiki" link and every ingested-page link belong.
  const wikis = await listHeadlessWikis();
  const defaultWiki = wikis.find((entry) => entry.isDefault) ?? wikis[0];
  if (!defaultWiki) notFound();

  return (
    <WikiSourcesPanel
      workspaceId={workspace.id}
      defaultWikiSlug={defaultWiki.slug}
      isAdmin={role === "admin"}
    />
  );
}
