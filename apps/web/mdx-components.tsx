import type { MDXComponents } from "mdx/types";

function slugFromChildren(children: React.ReactNode) {
  return String(children)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    h2: ({ children, id, ...props }) => (
      <h2
        id={id ?? slugFromChildren(children)}
        className="mt-10 scroll-mt-16 border-t border-[#ececea] pt-8 text-[20px] font-semibold leading-7 tracking-[-0.01em] text-ink first:mt-0 first:border-t-0 first:pt-0"
        {...props}
      >
        {children}
      </h2>
    ),
    h3: ({ children, id, ...props }) => (
      <h3
        id={id ?? slugFromChildren(children)}
        className="mt-7 scroll-mt-16 text-[15px] font-semibold leading-6 tracking-[-0.005em] text-ink"
        {...props}
      >
        {children}
      </h3>
    ),
    p: ({ children, ...props }) => (
      <p
        className="mt-3 text-[14px] leading-7 tracking-[-0.005em] text-ink-muted"
        {...props}
      >
        {children}
      </p>
    ),
    ul: ({ children, ...props }) => (
      <ul className="mt-3 space-y-2 pl-5 text-[14px] leading-7 text-ink-muted" {...props}>
        {children}
      </ul>
    ),
    ol: ({ children, ...props }) => (
      <ol
        className="mt-3 list-decimal space-y-2 pl-5 text-[14px] leading-7 text-ink-muted"
        {...props}
      >
        {children}
      </ol>
    ),
    li: ({ children, ...props }) => (
      <li className="pl-1 marker:text-ink-subtle" {...props}>
        {children}
      </li>
    ),
    strong: ({ children, ...props }) => (
      <strong className="font-semibold text-ink" {...props}>
        {children}
      </strong>
    ),
    a: ({ children, ...props }) => (
      <a
        className="font-medium text-ink underline decoration-[#d2d2cd] underline-offset-2 transition-colors hover:decoration-ink/60"
        {...props}
      >
        {children}
      </a>
    ),
    code: ({ children, ...props }) => (
      <code
        className="rounded bg-[#ececea] px-1 py-0.5 font-mono text-[12px] text-ink"
        {...props}
      >
        {children}
      </code>
    ),
    pre: ({ children, ...props }) => (
      <pre
        className="mt-4 overflow-x-auto rounded-lg border border-[#e6e6e3] bg-[#fbfbfa] p-4 text-[12.5px] leading-6 text-ink shadow-[0_1px_0_rgba(0,0,0,0.02)]"
        {...props}
      >
        {children}
      </pre>
    ),
    blockquote: ({ children, ...props }) => (
      <blockquote
        className="mt-4 border-l-2 border-[#d8d8d3] pl-4 text-[14px] leading-7 text-ink-muted"
        {...props}
      >
        {children}
      </blockquote>
    ),
    ...components,
  };
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
