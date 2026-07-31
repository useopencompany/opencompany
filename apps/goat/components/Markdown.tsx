import Link from "next/link";
import { type ElementType, memo } from "react";
import {
  type Components,
  defaultRemarkPlugins,
  Streamdown,
  type StreamdownProps,
} from "streamdown";

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

const LINK_CLASS =
  "font-medium text-ink underline decoration-border-strong underline-offset-2 transition-colors hover:decoration-ink/70";
const SAFE_EXTERNAL_URL_PATTERN = /^(https?:|mailto:|tel:)/i;

function isSafeHref(href: string) {
  return isInternalHref(href) || href.startsWith("#") || SAFE_EXTERNAL_URL_PATTERN.test(href);
}

function isInternalHref(href: string) {
  return href.startsWith("/") && !href.startsWith("//");
}

// Strips the AST `node` prop that Streamdown (like react-markdown) passes to every
// component, and renders the plain semantic tag instead of Streamdown's styled
// default so Goat's own `.session-markdown` CSS stays the single source of truth.
function plainElement<Tag extends keyof React.JSX.IntrinsicElements>(tag: Tag) {
  const Component = tag as ElementType;
  return function PlainElement(props: React.JSX.IntrinsicElements[Tag] & { node?: unknown }) {
    const rest = { ...props };
    delete rest.node;
    return <Component {...rest} />;
  };
}

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
  blockquote: plainElement("blockquote"),
  code: plainElement("code"),
  h1: plainElement("h1"),
  h2: plainElement("h2"),
  h3: plainElement("h3"),
  h4: plainElement("h4"),
  h5: plainElement("h5"),
  h6: plainElement("h6"),
  hr: plainElement("hr"),
  li: plainElement("li"),
  ol: plainElement("ol"),
  p: plainElement("p"),
  pre: plainElement("pre"),
  strong: plainElement("strong"),
  sub: plainElement("sub"),
  sup: plainElement("sup"),
  table: plainElement("table"),
  tbody: plainElement("tbody"),
  td: plainElement("td"),
  th: plainElement("th"),
  thead: plainElement("thead"),
  tr: plainElement("tr"),
  ul: plainElement("ul"),
};

// Passing a custom remarkPlugins array replaces Streamdown's defaults entirely,
// so GFM must be listed explicitly alongside Goat's soft-line-break transform.
type RemarkPlugin = NonNullable<StreamdownProps["remarkPlugins"]>[number];
const REMARK_PLUGINS: NonNullable<StreamdownProps["remarkPlugins"]> = [
  defaultRemarkPlugins.gfm as RemarkPlugin,
  remarkSoftLineBreaks,
];

const LINK_SAFETY: NonNullable<StreamdownProps["linkSafety"]> = { enabled: false };

// Streamdown's default rehype pipeline (rehype-raw + rehype-sanitize + rehype-harden)
// rewrites unsafe links into its own "Blocked URL" span before Goat's `a` override ever
// sees the node. Goat's link/HTML policy is already fully enforced at the component
// level (below) and via `skipHtml`/`disallowedElements`, so drop Streamdown's pipeline
// entirely rather than have two competing safety layers disagree on the rendered markup.
const REHYPE_PLUGINS: NonNullable<StreamdownProps["rehypePlugins"]> = [];

const STREAMING_ANIMATION = {
  animation: "blurIn",
  duration: 200,
  easing: "ease-out",
  sep: "word",
} as const;

export const Markdown = memo(function Markdown({
  content,
  className,
  mode = "static",
  isAnimating = false,
}: {
  content: string;
  className?: string;
  mode?: "static" | "streaming";
  isAnimating?: boolean;
}) {
  return (
    <Streamdown
      // Streamdown's built-in `space-y-4` would compound Goat's own block margins.
      className={
        className ? `session-markdown space-y-0 ${className}` : "session-markdown space-y-0"
      }
      mode={mode}
      isAnimating={isAnimating}
      animated={STREAMING_ANIMATION}
      parseIncompleteMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={MARKDOWN_COMPONENTS}
      skipHtml
      disallowedElements={["img"]}
      controls={false}
      linkSafety={LINK_SAFETY}
    >
      {content}
    </Streamdown>
  );
});

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
