"use client";

import { ExampleBlock, PageHeader } from "@/components/docs-primitives";
import { registry } from "@/lib/registry";
import { COMPONENT_TITLES, type ComponentSlug } from "@/lib/site";

export function ComponentShowcase({ slug }: { slug: ComponentSlug }) {
  const entry = registry[slug];

  return (
    <article>
      <PageHeader title={COMPONENT_TITLES[slug]} description={entry.description} />
      {entry.examples.map((example) => (
        <ExampleBlock key={example.title} title={example.title}>
          {example.content}
        </ExampleBlock>
      ))}
    </article>
  );
}
