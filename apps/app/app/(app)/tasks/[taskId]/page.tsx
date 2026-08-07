import { TaskDetailRoute } from "@/components/AppRoutes";

type TaskDetailPageProps = {
  params: Promise<{ taskId: string }>;
};

export default async function TaskDetailPage({ params }: TaskDetailPageProps) {
  const { taskId } = await params;
  return <TaskDetailRoute taskId={taskId} />;
}
