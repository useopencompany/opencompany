import { SentryPluginSettings } from "@/components/SentryPluginSettings";
import { getCompanySentryPluginAction, listSentryProjectsAction } from "@/lib/sentry-actions";
export default async function SentryPluginPage() {
  const plugin = await getCompanySentryPluginAction();
  const projects =
    plugin.connection && plugin.connection.status !== "disconnected"
      ? await listSentryProjectsAction(plugin.canManage).catch((error: unknown) => {
          console.error("Sentry projects could not be loaded", error);
          return { projects: [], nextCursor: null };
        })
      : { projects: [], nextCursor: null };
  return (
    <SentryPluginSettings
      plugin={plugin}
      projects={projects.projects}
      nextCursor={projects.nextCursor}
    />
  );
}
