import { GoatBrainRoute } from "@/components/GoatRoutes";
import { currentGoatUser } from "@/lib/auth";
import { listGoatBrainForBrain } from "@/lib/brain";
import { getGoatBrainOverviewStats } from "@/lib/brain-overview";

type PageProps = {
  params: Promise<{ path?: string[] }>;
};

export default async function GoatBrainPage({ params }: PageProps) {
  const { path } = await params;
  const segments = path ?? [];
  const { brains, activeBrain } = await currentGoatUser();
  const explicitBrain = segments[0] ? brains.find((brain) => brain.id === segments[0]) : null;
  const selectedBrain = explicitBrain ?? activeBrain;
  const routeBrainId = explicitBrain?.id ?? null;
  const brainPath = routeBrainId ? segments.slice(1) : segments;
  const isSettingsRoute = Boolean(explicitBrain && brainPath[0] === "settings");
  const [brain, overviewStats] =
    selectedBrain && !isSettingsRoute
      ? await Promise.all([
          listGoatBrainForBrain(selectedBrain.id),
          getGoatBrainOverviewStats(selectedBrain.id),
        ])
      : [null, null];

  return (
    <GoatBrainRoute
      path={brainPath}
      routeBrainId={routeBrainId}
      selectedBrain={selectedBrain ? brainSummaryView(selectedBrain) : null}
      initialBrainSnapshot={brain}
      initialOverviewStats={overviewStats}
    />
  );
}

function brainSummaryView(brain: {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: "workspace" | "restricted";
}) {
  return {
    id: brain.id,
    name: brain.name,
    slug: brain.slug,
    description: brain.description,
    visibility: brain.visibility,
  };
}
