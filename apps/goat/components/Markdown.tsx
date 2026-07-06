import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

const LINK_CLASS =
  "font-medium text-ink underline decoration-border-strong underline-offset-2 transition-colors hover:decoration-ink/70";
const SAFE_EXTERNAL_URL_PATTERN = /^(https?:|mailto:|tel:)/i;

const MARKDOWN_COMPONENTS: Components = {
  a: ({ children, href }) => {
    if (!href || !isSafeHref(href)) return <span>{children}</span>;
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
      <a href={href} target="_blank" rel="noreferrer noopener" className={LINK_CLASS}>
        {children}
      </a>
    );
  },
};

function isSafeHref(href: string) {
  return isInternalHref(href) || href.startsWith("#") || SAFE_EXTERNAL_URL_PATTERN.test(href);
}

function isInternalHref(href: string) {
  return href.startsWith("/") && !href.startsWith("//");
}

export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={className ? `session-markdown ${className}` : "session-markdown"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkSoftLineBreaks]}
        components={MARKDOWN_COMPONENTS}
        skipHtml
        disallowedElements={["img"]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function remarkSoftLineBreaks() {
  return (tree: MarkdownNode) => {
    visitMarkdownNode(tree);
  };
}

function visitMarkdownNode(node: MarkdownNode) {
  if (!node.children) return;

  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.value?.includes("\n")) {
      return splitTextNodeAtLineBreaks(child.value);
    }

    visitMarkdownNode(child);
    return [child];
  });
}

function splitTextNodeAtLineBreaks(value: string): MarkdownNode[] {
  return value.split("\n").flatMap((text, index) => {
    const nodes: MarkdownNode[] = index === 0 ? [] : [{ type: "break" }];
    if (text) nodes.push({ type: "text", value: text });
    return nodes;
  });
}
