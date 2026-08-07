import { TaskDetailRoute } from "@/components/AppRoutes";

type TaskHarnessRunPageProps = {
  params: Promise<{ taskId: string }>;
};

export default async function TaskHarnessRunPage({ params }: TaskHarnessRunPageProps) {
  const { taskId } = await params;
  return <TaskDetailRoute taskId={taskId} />;
}
