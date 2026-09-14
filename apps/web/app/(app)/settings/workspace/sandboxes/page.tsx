import { calculateSandboxUsageCost } from "@opencompany/billing";
import { SANDBOX_SIZE_SPEC_LIST } from "@opencompany/core/sandbox-sizes";
import { SandboxSettingsRoute } from "@/components/Routes";
import type { SandboxSizeOptionView } from "@/components/SandboxSettingsPanel";
import { getWorkspaceSandboxSizeAction } from "@/lib/sandbox-size";

const HOUR_MS = 60 * 60 * 1000;

// Priced here rather than in the client component so the rate table stays on the
// server and the quoted price can never drift from what the sandbox meter charges.
const SANDBOX_SIZE_OPTIONS: SandboxSizeOptionView[] = SANDBOX_SIZE_SPEC_LIST.map((spec) => ({
  size: spec.size,
  label: spec.label,
  summary: spec.summary,
  cpuCount: spec.cpuCount,
  memoryMB: spec.memoryMB,
  hourlyCostUsdMicros: calculateSandboxUsageCost({
    vcpu: spec.cpuCount,
    ramMiB: spec.memoryMB,
    activeMs: HOUR_MS,
  }).totalCostUsdMicros,
}));

export default async function SandboxSettingsPage() {
  const sandboxSize = await getWorkspaceSandboxSizeAction();
  return (
    <SandboxSettingsRoute sandboxSize={sandboxSize} sandboxSizeOptions={SANDBOX_SIZE_OPTIONS} />
  );
}
