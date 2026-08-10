import { hc } from "hono/client";
import type { V1AppType } from "./routes";

export { formatEventCursor, parseEventCursor, parseRunEvent } from "./events";

export type OpenCompanyClientOptions = Parameters<typeof hc>[1];

export function createOpenCompanyClient(baseUrl: string, options?: OpenCompanyClientOptions) {
  return hc<V1AppType>(baseUrl, options);
}

export type OpenCompanyClient = ReturnType<typeof createOpenCompanyClient>;
