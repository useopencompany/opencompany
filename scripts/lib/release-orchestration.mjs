const RENDER_SURFACE_CONFIG = {
  api: {
    serviceIdEnv: "RENDER_API_SERVICE_ID",
    maxShutdownDelaySeconds: 60,
  },
  runner: {
    serviceIdEnv: "RENDER_SERVICE_ID",
    maxShutdownDelaySeconds: 300,
  },
};

export function renderSurfaceConfig(surface) {
  const config = RENDER_SURFACE_CONFIG[surface];
  if (!config) throw new Error(`Unknown Render surface: ${surface}`);
  return config;
}

export function renderSurfaceResults(selectedSurfaces, settledBySurface) {
  return Object.fromEntries(
    ["api", "runner"].map((surface) => {
      if (!selectedSurfaces.includes(surface)) return [surface, "skipped"];
      return [surface, settledBySurface[surface]?.status === "fulfilled" ? "success" : "failure"];
    }),
  );
}

export function webDependenciesPassed(plan, renderResults) {
  return (
    (!plan.api || renderResults.api === "success") &&
    (!plan.runner || renderResults.runner === "success")
  );
}

export function deploymentFinalState({ selected, attempted, succeeded }) {
  if (!selected || !attempted) return "inactive";
  return succeeded ? "success" : "failure";
}

export function unsuccessfulSelectedSurfaces(surfaceResults) {
  return Object.entries(surfaceResults)
    .filter(([, state]) => state.selected && (!state.deploymentId || state.result !== "success"))
    .map(([surface]) => surface);
}
