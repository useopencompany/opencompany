import { redirect } from "next/navigation";

// The per-brain MCP setup flow moved to the personal MCP settings tab.
export default function McpSetupPage() {
  redirect("/settings/mcp");
}
