import { GoatTaskDetailRoute } from "@/components/GoatRoutes";

type TaskDetailPageProps = {
  params: Promise<{ taskId: string }>;
};

export default async function TaskDetailPage({ params }: TaskDetailPageProps) {
  const { taskId } = await params;
  return <GoatTaskDetailRoute taskId={taskId} />;
}
