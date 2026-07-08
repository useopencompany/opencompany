import { GoatTaskRunRoute } from "@/components/GoatRoutes";

type TaskHarnessRunPageProps = {
  params: Promise<{ taskId: string }>;
};

export default async function TaskHarnessRunPage({ params }: TaskHarnessRunPageProps) {
  const { taskId } = await params;
  return <GoatTaskRunRoute taskId={taskId} />;
}
