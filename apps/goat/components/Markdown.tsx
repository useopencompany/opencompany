import Link from "next/link";
import { memo, useMemo } from "react";
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

// Remark parsing is the dominant cost when streaming: without memoization the
// entire message (and every other message in the thread) re-parses on every
// chunk. Splitting into top-level blocks and memoizing each one means only the
// block currently receiving tokens re-parses.
const MarkdownBlock = memo(function MarkdownBlock({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkSoftLineBreaks]}
      components={MARKDOWN_COMPONENTS}
      skipHtml
      disallowedElements={["img"]}
    >
      {content}
    </ReactMarkdown>
  );
});

export const Markdown = memo(function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const blocks = useMemo(() => splitMarkdownBlocks(content), [content]);
  return (
    <div className={className ? `session-markdown ${className}` : "session-markdown"}>
      {blocks.map((block, index) => (
        // Blocks only append or grow at the tail while streaming, so the index
        // is a stable identity for memoization.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <MarkdownBlock key={index} content={block} />
      ))}
    </div>
  );
});

// Splits markdown into top-level blocks at blank lines, keeping fenced code
// blocks (which may contain blank lines) intact.
function splitMarkdownBlocks(content: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  for (const line of content.split("\n")) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch?.[1]) {
      if (!fence) {
        fence = fenceMatch[1];
      } else if (fenceMatch[1].startsWith(fence[0] ?? "") && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
    }
    if (!fence && line.trim() === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks;
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
