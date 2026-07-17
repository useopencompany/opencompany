import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdaptiveToolExposureLab } from "@/components/AdaptiveToolExposureLab";
import { analyzeAdaptiveToolQuery } from "@/experiments/adaptive-tool-exposure/activation";
import { GOAT_MODELS } from "@/lib/model-options";

export const metadata: Metadata = {
  title: "Adaptive tool exposure lab",
};

const INITIAL_QUERY =
  "Find the latest email from Ada about launch readiness, then post a concise summary to Slack #launch.";

export default function AdaptiveToolExposurePage() {
  if (process.env.NODE_ENV !== "development") notFound();

  return (
    <AdaptiveToolExposureLab
      initialQuery={INITIAL_QUERY}
      initialSnapshot={analyzeAdaptiveToolQuery(INITIAL_QUERY)}
      modelOptions={GOAT_MODELS.map((model) => ({ id: model.id, label: model.label }))}
    />
  );
}
