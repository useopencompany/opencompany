import type {
  AdaptiveExposureSnapshot,
  AdaptiveObservedCall,
  AdaptiveStepMeasurement,
} from "./types";

export type AdaptiveEvalMode = "flat" | "search" | "adaptive";
export type AdaptiveEvalCategory = "single" | "multi" | "long_tail" | "implicit" | "no_tool";

export type AdaptiveEvalTask = {
  id: string;
  category: AdaptiveEvalCategory;
  prompt: string;
  expectedToolPointers: string[];
  expectedIntegrationIds: string[];
  notes: string;
};

export type AdaptiveEvalScore = {
  requiredToolRecall: number;
  toolPrecision: number;
  exact: boolean;
  validCallRate: number;
  missingToolPointers: string[];
  extraToolPointers: string[];
};

export type AdaptiveEvalCase = {
  taskId: string;
  category: AdaptiveEvalCategory;
  mode: AdaptiveEvalMode;
  model: string;
  exposure: AdaptiveExposureSnapshot;
  estimatedInitialContextTokens: number;
  firstStepInputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  durationMs: number;
  steps: AdaptiveStepMeasurement[];
  calls: AdaptiveObservedCall[];
  catalogSearches: number;
  explicitLevel1Expansions: number;
  explicitLevel2Expansions: number;
  triggerFalseNegative: boolean;
  recoveredTriggerFalseNegative: boolean;
  finalText: string;
  score: AdaptiveEvalScore;
  error?: string;
};

export type AdaptiveEvalSummary = {
  mode: AdaptiveEvalMode;
  runs: number;
  errors: number;
  meanRequiredToolRecall: number;
  meanToolPrecision: number;
  exactAccuracy: number;
  meanValidCallRate: number;
  meanFirstStepInputTokens: number;
  meanTotalInputTokens: number;
  meanSteps: number;
  meanDurationMs: number;
  triggerFalseNegatives: number;
  recoveredTriggerFalseNegatives: number;
  meanCatalogSearches: number;
  meanExplicitExpansions: number;
};

export type AdaptiveEvalRun = {
  schemaVersion: "goat.adaptive-tool-exposure-eval.v1";
  createdAt: string;
  model: string;
  repetitions: number;
  tasks: AdaptiveEvalTask[];
  cases: AdaptiveEvalCase[];
  summaries: AdaptiveEvalSummary[];
};
