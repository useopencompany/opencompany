import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const MARKDOWN_COMPONENTS: Components = {
  a: ({ children, href }) =>
    href ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="font-medium text-ink underline decoration-border-strong underline-offset-2 transition-colors hover:decoration-ink/70"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

export function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div
      className={
        className ? `session-markdown ${className}` : "session-markdown"
      }
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={MARKDOWN_COMPONENTS}
        skipHtml
        disallowedElements={["img"]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
