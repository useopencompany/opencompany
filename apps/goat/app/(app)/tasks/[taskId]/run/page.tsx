import { GoatTaskDetailRoute } from "@/components/GoatRoutes";

type TaskHarnessRunPageProps = {
  params: Promise<{ taskId: string }>;
};

export default async function TaskHarnessRunPage({ params }: TaskHarnessRunPageProps) {
  const { taskId } = await params;
  return <GoatTaskDetailRoute taskId={taskId} />;
}
