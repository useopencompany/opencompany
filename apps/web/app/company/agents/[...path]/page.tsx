"use client";

import { useParams } from "next/navigation";
import AgentDetail from "@/components/AgentDetail";

export default function AgentPage() {
  const params = useParams<{ path?: string[] }>();
  const path = params.path ?? [];
  const idOrPath = path.map(decodeURIComponent).join("/");

  return <AgentDetail idOrPath={idOrPath} />;
}
