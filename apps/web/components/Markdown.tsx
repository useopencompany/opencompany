import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Shared renderer for agent-authored markdown (chat replies, inbox card bodies/steps).
// Typography lives in the global `session-markdown` stylesheet; pass `className` to set the
// surrounding font scale/color (and `markdown-compact` in dense card contexts to keep
// headings near body size).

export const MARKDOWN_COMPONENTS: Components = {
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-ink underline decoration-border-strong underline-offset-2 transition-colors hover:decoration-ink/70"
    >
      {children}
    </a>
  ),
};

export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={className ? `session-markdown ${className}` : "session-markdown"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
