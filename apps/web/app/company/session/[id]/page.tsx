import SessionView from "@/components/SessionView";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  // Auth is enforced by the parent workspace layout through AppShell.
  const { id } = await params;

  return <SessionView sessionId={id} />;
}
