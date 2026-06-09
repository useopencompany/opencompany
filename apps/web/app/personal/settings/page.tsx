"use client";

import PersonalSettingsView from "@/components/personal/PersonalSettingsView";

// Lightweight personal settings (Pro mode, appearance, account). Reads shared state from the
// /personal layout context, so no route-level data loading is needed here.
export default function PersonalSettingsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <PersonalSettingsView />
    </div>
  );
}
