import { Skeleton } from "@opencompany/ui/components/skeleton";
import { SettingsContent } from "@/components/SettingsChrome";

export default function PluginDetailLoading() {
  return (
    <SettingsContent
      title="Linear"
      description="Loading plugin settings."
      backLink={{ href: "/settings/plugins", label: "Plugins" }}
    >
      {["Plugin", "Accounts", "Tools", "Skills"].map((section) => (
        <section key={section} aria-label={`Loading ${section.toLocaleLowerCase()}`}>
          <Skeleton className="mb-2 h-4 w-28" />
          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        </section>
      ))}
    </SettingsContent>
  );
}
