"use client";

import { useParams } from "next/navigation";
import SessionView from "@/components/SessionView";
import { SessionPageSkeleton } from "@/components/WorkspaceRouteSkeletons";

export default function SessionPage() {
  const params = useParams<{ id?: string }>();
  const id = params.id;

  if (!id) return <SessionPageSkeleton />;

  return <SessionView sessionId={id} />;
}
