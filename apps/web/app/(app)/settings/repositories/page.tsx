import { GoatRepositoriesSettingsRoute } from "@/components/GoatRoutes";
import { currentGoatUser } from "@/lib/auth";
import { listGoatRepoConfigsAction } from "@/lib/repo-config-actions";

export default async function RepositoriesSettingsPage() {
  const context = await currentGoatUser();
  const { repositories, configs } = await listGoatRepoConfigsAction();
  return (
    <GoatRepositoriesSettingsRoute
      repositories={repositories}
      configs={configs}
      canEdit={context.role === "admin"}
    />
  );
}
