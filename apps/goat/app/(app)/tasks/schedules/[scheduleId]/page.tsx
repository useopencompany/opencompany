import { GoatTaskScheduleDetailRoute } from "@/components/GoatRoutes";

type ScheduleDetailPageProps = {
  params: Promise<{ scheduleId: string }>;
};

export default async function ScheduleDetailPage({ params }: ScheduleDetailPageProps) {
  const { scheduleId } = await params;
  return <GoatTaskScheduleDetailRoute scheduleId={scheduleId} />;
}
