import { TaskDetailRoute } from "@/components/Routes";

type TaskHarnessRunPageProps = {
  params: Promise<{ taskId: string }>;
};

export default async function TaskHarnessRunPage({ params }: TaskHarnessRunPageProps) {
  const { taskId } = await params;
  return <TaskDetailRoute taskId={taskId} />;
}
