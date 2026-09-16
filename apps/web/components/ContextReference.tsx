"use client";

import { Puzzle } from "lucide-react";
import type { ContextReference as Reference } from "@/lib/context-references";
import { contextReferenceRanges } from "@/lib/context-references";
import { SERVICE_MARKS } from "@/lib/service-marks";

export function ContextReferenceIcon({ plugin }: { plugin: string }) {
  const Icon = SERVICE_MARKS[plugin as keyof typeof SERVICE_MARKS]?.Icon ?? Puzzle;
  return <Icon size={14} className="inline-block shrink-0 align-[-2px]" aria-hidden="true" />;
}

export function ContextReferenceChip({ reference }: { reference: Reference }) {
  return (
    <a
      href={reference.href}
      className="context-reference"
      data-context-reference={reference.kind}
      title={reference.kind === "repository" ? reference.href : `${reference.label} plugin`}
      {...(reference.kind === "repository" ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      <ContextReferenceIcon plugin={reference.plugin} />
      <span>{reference.label}</span>
    </a>
  );
}

export function ContextReferenceText({ text }: { text: string }) {
  const ranges = contextReferenceRanges(text);
  const parts = ranges.flatMap((reference, index) => {
    const before = text.slice(ranges[index - 1]?.end ?? 0, reference.start);
    return [before, <ContextReferenceChip key={reference.start} reference={reference} />];
  });
  return (
    <>
      {parts}
      {text.slice(ranges.at(-1)?.end ?? 0)}
    </>
  );
}
