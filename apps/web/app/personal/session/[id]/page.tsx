import { PersonalSessionCanvas } from "@/components/session-split/PersonalSessionSplit";

// Live session transcript for the personal agent. Auth is enforced by the personal layout.
// The canvas renders the session inside the split-pane layout: a single pane looks identical
// to the plain SessionView, and dropping sidebar sessions onto pane edges splits the view.
export default async function PersonalSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PersonalSessionCanvas sessionId={id} />;
}
