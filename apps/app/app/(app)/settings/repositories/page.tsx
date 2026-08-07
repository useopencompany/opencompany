import { getDb } from "@opencompany/db/client";
import { listGoatRepoConfigs, listGoatWorkspaceRepositories } from "@opencompany/db/repo-configs";
import { GoatRepositoriesSettingsRoute } from "@/components/GoatRoutes";
import { currentGoatUser } from "@/lib/auth";

export default async function RepositoriesSettingsPage() {
  const context = await currentGoatUser();
  const db = getDb();
  const [repositories, configs] = await Promise.all([
    listGoatWorkspaceRepositories({ db, workspaceId: context.workspace.id }),
    listGoatRepoConfigs({ db, workspaceId: context.workspace.id }),
  ]);
  return (
    <GoatRepositoriesSettingsRoute
      repositories={repositories}
      configs={configs}
      canEdit={context.role === "admin"}
    />
  );
}
