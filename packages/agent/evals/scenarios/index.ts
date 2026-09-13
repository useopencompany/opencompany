import { discoveryScenarios } from "./discovery";
import { linearScenarios } from "./linear";
import { triageScenarios } from "./triage";
export const scenarios = [...discoveryScenarios, ...linearScenarios, ...triageScenarios];
