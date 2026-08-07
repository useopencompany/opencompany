import { registerGoatNextObservability } from "@opencompany/telemetry/next";

export function register() {
  registerGoatNextObservability({ serviceName: "opencompany-goat" });
}
