import { notFound } from "next/navigation";
import { GoatTaskDetail } from "@/components/goat-tasks/GoatTaskDetail";
import { currentWorkspace } from "@/lib/auth";
import { loadGoatTaskDetailForUser } from "@/lib/goat-tasks/service";

export default async function GoatTaskPage({ params }: { params: Promise<{ displayId: string }> }) {
  const { displayId } = await params;
  const { authUser } = await currentWorkspace();
  const detail = await loadGoatTaskDetailForUser({
    taskDisplayIdOrId: decodeURIComponent(displayId),
    authUserWorkosId: authUser.id,
  });

  if (!detail) notFound();

  return <GoatTaskDetail detail={detail} />;
}
