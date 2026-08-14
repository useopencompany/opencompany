import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { openapi } from "@/lib/openapi";

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  plugins: [openapi.loaderPlugin()],
});
