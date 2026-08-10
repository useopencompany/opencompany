import { registerGoatNextObservability } from "@opencompany/goat-observability/next";

export function register() {
  registerGoatNextObservability({ serviceName: "opencompany-goat" });
}
