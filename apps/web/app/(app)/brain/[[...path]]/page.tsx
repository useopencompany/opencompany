import { GoatBrainRoute } from "@/components/GoatRoutes";
import { currentGoatUser } from "@/lib/auth";
import {
  getHeadlessBrainOverview,
  getHeadlessBrainSnapshot,
} from "@/lib/headless-knowledge-server";
import { brainDocumentToView, brainFolderToView } from "@/lib/headless-knowledge-types";

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
  const isOverviewRoute =
    brainPath.length === 0 || (brainPath.length === 1 && brainPath[0] === "overview");
  // The overview only needs aggregate metrics. Loading every document here made
  // navigation time and RSC payload size grow with the Brain, even though the
  // live collection fills the file tree after the route is visible.
  const [brain, overviewStats] = await Promise.all([
    selectedBrain && !isSettingsRoute && !isOverviewRoute
      ? getHeadlessBrainSnapshot(selectedBrain.id).then((snapshot) => ({
          folders: snapshot.folders.map(brainFolderToView),
          documents: snapshot.documents.map(brainDocumentToView),
        }))
      : Promise.resolve(null),
    selectedBrain && !isSettingsRoute
      ? getHeadlessBrainOverview(selectedBrain.id)
      : Promise.resolve(null),
  ]);

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
