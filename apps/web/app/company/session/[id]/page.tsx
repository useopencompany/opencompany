import SessionSplitView from "@/components/SessionSplitView";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  // Auth is enforced by the parent workspace layout through AppShell.
  const { id } = await params;

  // The split-view container reads `?split=` to render extra panes; a plain session URL
  // renders the single SessionView exactly as before.
  return <SessionSplitView sessionId={id} />;
}
