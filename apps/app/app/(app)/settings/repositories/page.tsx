import { getDb } from "@opencompany/db/client";
import { listRepoConfigs, listWorkspaceRepositories } from "@opencompany/db/repo-configs";
import { RepositoriesSettingsRoute } from "@/components/AppRoutes";
import { currentUser } from "@/lib/auth";

export default async function RepositoriesSettingsPage() {
  const context = await currentUser();
  const db = getDb();
  const [repositories, configs] = await Promise.all([
    listWorkspaceRepositories({ db, workspaceId: context.workspace.id }),
    listRepoConfigs({ db, workspaceId: context.workspace.id }),
  ]);
  return (
    <RepositoriesSettingsRoute
      repositories={repositories}
      configs={configs}
      canEdit={context.role === "admin"}
    />
  );
}
