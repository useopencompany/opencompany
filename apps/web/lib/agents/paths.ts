import { agentPathForSlug, slugifyAgentTitle } from "@opencompany/agent-runtime";

export function resolveAgentPath(input: {
  title: string;
  existingPaths: Iterable<string>;
  currentPath?: string | null | undefined;
}) {
  const slug = slugifyAgentTitle(input.title);
  const existing = new Set(
    Array.from(input.existingPaths).filter((path) => path !== input.currentPath),
  );
  let index = 0;

  while (true) {
    const candidate = agentPathForSlug(index === 0 ? slug : `${slug}-${index + 1}`);
    if (!existing.has(candidate)) return candidate;
    index += 1;
  }
}
