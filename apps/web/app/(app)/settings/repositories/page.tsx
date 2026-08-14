import { RepositoriesSettingsRoute } from "@/components/Routes";
import { currentUser } from "@/lib/auth";
import { listRepoConfigsAction } from "@/lib/repo-config-actions";

export default async function RepositoriesSettingsPage() {
  const context = await currentUser();
  const { repositories, configs } = await listRepoConfigsAction();
  return (
    <RepositoriesSettingsRoute
      repositories={repositories}
      configs={configs}
      canEdit={context.role === "admin"}
    />
  );
}
