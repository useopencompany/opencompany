import { registerNextObservability } from "@opencompany/telemetry/next";

export function register() {
  registerNextObservability({ serviceName: "opencompany-goat" });
}
