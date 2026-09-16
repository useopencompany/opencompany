import { redirect } from "next/navigation";

// The old per-Brain MCP setup flow moved to the personal MCP settings tab.
export default function McpSetupPage() {
  redirect("/settings/mcp");
}
