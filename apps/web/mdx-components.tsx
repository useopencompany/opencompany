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
        className="mb-3 mt-12 scroll-mt-20 text-[20px] font-semibold leading-snug tracking-[-0.015em] text-ink first:mt-0"
        {...props}
      >
        {children}
      </h2>
    ),
    h3: ({ children, id, ...props }) => (
      <h3
        id={id ?? slugFromChildren(children)}
        className="mb-2 mt-8 scroll-mt-20 text-[15.5px] font-semibold leading-snug tracking-[-0.01em] text-ink"
        {...props}
      >
        {children}
      </h3>
    ),
    h4: ({ children, id, ...props }) => (
      <h4
        id={id ?? slugFromChildren(children)}
        className="mb-2 mt-6 scroll-mt-20 text-[14px] font-semibold leading-snug tracking-[-0.005em] text-ink"
        {...props}
      >
        {children}
      </h4>
    ),
    p: ({ children, ...props }) => (
      <p
        className="mt-4 text-[14px] leading-[1.75] tracking-[-0.003em] text-ink-muted first:mt-0"
        {...props}
      >
        {children}
      </p>
    ),
    ul: ({ children, ...props }) => (
      <ul
        className="mt-4 space-y-1.5 pl-5 text-[14px] leading-[1.75] text-ink-muted [&>li]:relative [&>li]:pl-1"
        style={{ listStyleType: "disc" }}
        {...props}
      >
        {children}
      </ul>
    ),
    ol: ({ children, ...props }) => (
      <ol
        className="mt-4 list-decimal space-y-1.5 pl-5 text-[14px] leading-[1.75] text-ink-muted [&>li]:pl-1"
        {...props}
      >
        {children}
      </ol>
    ),
    li: ({ children, ...props }) => (
      <li className="marker:text-ink-subtle" {...props}>
        {children}
      </li>
    ),
    strong: ({ children, ...props }) => (
      <strong className="font-semibold text-ink" {...props}>
        {children}
      </strong>
    ),
    em: ({ children, ...props }) => (
      <em className="italic text-ink-muted" {...props}>
        {children}
      </em>
    ),
    a: ({ children, ...props }) => (
      <a
        className="font-medium text-ink underline decoration-[#c8c8c2] underline-offset-[3px] transition-colors hover:decoration-ink"
        {...props}
      >
        {children}
      </a>
    ),
    code: ({ children, ...props }) => (
      <code
        className="rounded-[4px] border border-[#e6e6e3] bg-[#f0f0ed] px-[5px] py-[2px] font-mono text-[12px] leading-none text-ink"
        {...props}
      >
        {children}
      </code>
    ),
    pre: ({ children, ...props }) => (
      <pre
        className="mt-5 overflow-x-auto rounded-xl border border-[#e2e2de] bg-[#f5f5f2] px-5 py-4 text-[12.5px] leading-[1.65] text-ink shadow-[0_1px_3px_rgba(0,0,0,0.04),0_1px_0_rgba(0,0,0,0.02)]"
        {...props}
      >
        {children}
      </pre>
    ),
    blockquote: ({ children, ...props }) => (
      <blockquote
        className="mt-5 rounded-r-lg border-l-[3px] border-[#c8c8c2] bg-[#f5f5f2] px-5 py-3 text-[13.5px] leading-[1.7] text-ink-muted"
        {...props}
      >
        {children}
      </blockquote>
    ),
    table: ({ children, ...props }) => (
      <div className="mt-5 overflow-x-auto rounded-xl border border-[#e2e2de]">
        <table className="w-full border-collapse text-[13px]" {...props}>
          {children}
        </table>
      </div>
    ),
    thead: ({ children, ...props }) => (
      <thead className="border-b border-[#e2e2de] bg-[#f0f0ed]" {...props}>
        {children}
      </thead>
    ),
    tbody: ({ children, ...props }) => (
      <tbody className="divide-y divide-[#ececea]" {...props}>
        {children}
      </tbody>
    ),
    tr: ({ children, ...props }) => (
      <tr className="transition-colors hover:bg-[#fafaf8]" {...props}>
        {children}
      </tr>
    ),
    th: ({ children, ...props }) => (
      <th
        className="px-4 py-2.5 text-left text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-muted"
        {...props}
      >
        {children}
      </th>
    ),
    td: ({ children, ...props }) => (
      <td className="px-4 py-2.5 text-[13px] leading-relaxed text-ink-muted" {...props}>
        {children}
      </td>
    ),
    hr: ({ ...props }) => <hr className="my-8 border-[#e6e6e3]" {...props} />,
    ...components,
  };
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
