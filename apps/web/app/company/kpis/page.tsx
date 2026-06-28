import { KpiDashboardView } from "@/components/kpis/KpiDashboardView";
import { currentWorkspace } from "@/lib/auth";
import { loadKpiDashboardState } from "@/lib/kpis/data";

export default async function KpisPage() {
  const { workspace } = await currentWorkspace();
  const state = await loadKpiDashboardState(workspace.id);

  return <KpiDashboardView state={state} />;
}
