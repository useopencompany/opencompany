import SessionView from "@/components/SessionView";

// Live session transcript for the personal agent. Auth is enforced by the personal layout.
export default async function PersonalSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SessionView sessionId={id} />;
}
