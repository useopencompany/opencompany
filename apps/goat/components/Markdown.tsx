import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const LINK_CLASS =
  "font-medium text-ink underline decoration-border-strong underline-offset-2 transition-colors hover:decoration-ink/70";

const MARKDOWN_COMPONENTS: Components = {
  a: ({ children, href }) => {
    if (!href) return <span>{children}</span>;
    if (isInternalHref(href)) {
      return (
        <Link href={href} className={LINK_CLASS}>
          {children}
        </Link>
      );
    }
    if (href.startsWith("#")) {
      return (
        <a href={href} className={LINK_CLASS}>
          {children}
        </a>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={LINK_CLASS}
      >
        {children}
      </a>
    );
  },
};

function isInternalHref(href: string) {
  return href.startsWith("/") && !href.startsWith("//");
}

export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={className ? `session-markdown ${className}` : "session-markdown"}>
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
