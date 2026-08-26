"use client";

import { Alert, AlertDescription, AlertTitle } from "@opencompany/ui/components/alert";
import { Button } from "@opencompany/ui/components/button";
import { AlertCircle } from "lucide-react";
import { SettingsContent } from "@/components/SettingsChrome";

export default function PluginDetailError({ reset }: { reset: () => void }) {
  return (
    <SettingsContent
      title="Linear"
      description="Plugin settings could not be loaded."
      backLink={{ href: "/settings/plugins", label: "Plugins" }}
    >
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Plugin settings unavailable</AlertTitle>
        <AlertDescription>
          <p>Try loading this page again.</p>
          <Button variant="outline" size="sm" onClick={reset}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    </SettingsContent>
  );
}
