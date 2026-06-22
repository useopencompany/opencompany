import type { Metadata } from "next";
import { SessionWorkspace } from "@/components/session-split/SessionWorkspace";
import type { SessionSummary } from "@/types/session-layout";

export const metadata: Metadata = {
  title: "Split sessions prototype",
};

// Mock data for the prototype — the real integration feeds the live sidebar
// sessions (SidebarSessionPayload → SessionSummary) into SessionWorkspace.
const MOCK_SESSIONS: SessionSummary[] = [
  { id: "ses_01J9ZK3W8AQX4T", name: "Fix onboarding redirect loop" },
  { id: "ses_01J9ZKD2QM7Y2B", name: "Refactor memory keeper pass" },
  { id: "ses_01J9ZKJH5TN8C3", name: "Draft investor update email" },
  { id: "ses_01J9ZKPX0CW5D9", name: "Granola ingestion connector" },
  { id: "ses_01J9ZKVB7NM1E6", name: "Debug runner sandbox latency" },
  { id: "ses_01J9ZL19RDK4F2", name: "Q3 hiring plan research" },
];

export default function SplitPrototypePage() {
  return (
    <div className="h-dvh w-full overflow-hidden bg-canvas text-ink">
      <SessionWorkspace sessions={MOCK_SESSIONS} />
    </div>
  );
}
