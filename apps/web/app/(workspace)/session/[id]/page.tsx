import { notFound } from "next/navigation";
import SessionView from "@/components/SessionView";
import { loadAgentSessionForPage } from "@/lib/agent-sessions/actions";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await loadAgentSessionForPage(id);
  if (!data) notFound();

  return (
    <SessionView
      session={{
        ...data.session,
        abortRequestedAt: data.session.abortRequestedAt?.toISOString() ?? null,
        createdAt: data.session.createdAt.toISOString(),
        updatedAt: data.session.updatedAt.toISOString(),
      }}
      initialMessages={data.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        status: message.status,
        modelMessage: message.modelMessage,
        toolName: message.toolName,
        toolCallId: message.toolCallId,
      }))}
      initialEvents={data.events.map((event) => ({
        id: event.id,
        type: event.type,
        messageId: event.messageId,
        payload: event.payload,
      }))}
      runnerUrl={data.runnerUrl}
      streamToken={data.token}
    />
  );
}
