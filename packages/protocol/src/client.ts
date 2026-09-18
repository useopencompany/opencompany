import { hc } from "hono/client";
import type { V1AppType } from "./routes";

export {
  formatEventCursor,
  parseEventCursor,
  parseRunEvent,
  parseRunStreamEvent,
} from "./events";
export * from "./run-stream";

export type ApiClientOptions = Parameters<typeof hc>[1];

export function createApiClient(baseUrl: string, options?: ApiClientOptions) {
  return hc<V1AppType>(baseUrl, options);
}

export type ApiClient = ReturnType<typeof createApiClient>;
