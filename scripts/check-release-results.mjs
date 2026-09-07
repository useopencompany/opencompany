#!/usr/bin/env node

import { unsuccessfulSelectedSurfaces } from "./lib/release-orchestration.mjs";

const surfaces = ["database", "api", "runner", "web", "marketing", "docs"];
const results = Object.fromEntries(
  surfaces.map((surface) => {
    const prefix = surface.toUpperCase();
    return [
      surface,
      {
        selected: process.env[`${prefix}_SELECTED`] === "true",
        deploymentId: process.env[`${prefix}_DEPLOYMENT_ID`]?.trim() ?? "",
        result: process.env[`${prefix}_RESULT`]?.trim() ?? "",
      },
    ];
  }),
);
const unsuccessful = unsuccessfulSelectedSurfaces(results);

if (unsuccessful.length > 0) {
  for (const surface of unsuccessful) {
    const state = results[surface];
    console.error(
      `::error::Selected ${surface} release did not succeed (deployment: ${
        state.deploymentId || "missing"
      }, result: ${state.result || "missing"}).`,
    );
  }
  process.exit(1);
}

console.log("Every selected production surface succeeded.");
