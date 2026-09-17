import { discoveryScenarios } from "./discovery";
import { linearScenarios } from "./linear";
import { triageScenarios } from "./triage";
import { workflowScenarios } from "./workflows";
export const scenarios = [
  ...discoveryScenarios,
  ...linearScenarios,
  ...triageScenarios,
  ...workflowScenarios,
];
