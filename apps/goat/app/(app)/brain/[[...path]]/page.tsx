import { GoatBrainRoute } from "@/components/GoatRoutes";

type PageProps = {
  params: Promise<{ path?: string[] }>;
};

export default async function GoatBrainPage({ params }: PageProps) {
  const { path } = await params;
  return <GoatBrainRoute path={path ?? []} />;
}
