import type { Metadata } from "next";
import { ToolPermissionsPrototype } from "@/components/prototypes/ToolPermissionsPrototype";

export const metadata: Metadata = { title: "Prototype · Tool-level permissions" };

// Design prototype for the tool-level permission proposal in
// docs/future-concepts/tool-level-permissions.md. Signed-in route (the proxy only exempts
// /internal/observability/server-error), entirely client-side, and it never touches a real
// connection — the point is to feel the interaction before any of it is built.
export default function ToolPermissionsPrototypePage() {
  return <ToolPermissionsPrototype />;
}
