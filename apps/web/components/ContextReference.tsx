"use client";

import { Puzzle } from "lucide-react";
import type { ContextReference as Reference } from "@/lib/context-references";
import { contextReferenceRanges } from "@/lib/context-references";
import { SERVICE_MARKS, type ServiceMark } from "@/lib/service-marks";

function referenceMark(plugin: string): ServiceMark | undefined {
  return Object.hasOwn(SERVICE_MARKS, plugin)
    ? SERVICE_MARKS[plugin as keyof typeof SERVICE_MARKS]
    : undefined;
}

export function contextReferenceClassName(plugin: string) {
  const inlineClassName = referenceMark(plugin)?.inlineClassName;
  return inlineClassName ? `context-reference ${inlineClassName}` : "context-reference";
}

export function ContextReferenceIcon({ plugin, size = 16 }: { plugin: string; size?: number }) {
  const mark = referenceMark(plugin);
  const Icon = mark?.InlineIcon ?? mark?.Icon ?? Puzzle;
  return (
    <Icon
      size={size}
      className={`inline-block shrink-0${mark?.inlineClassName ? ` ${mark.inlineClassName}` : ""}`}
      aria-hidden="true"
    />
  );
}

export function ContextReferenceOptionContent({
  reference,
}: {
  reference: Reference & { description: string };
}) {
  return (
    <>
      <ContextReferenceIcon plugin={reference.plugin} size={20} />
      <span className="context-mention-label">
        <span className="context-mention-name">{reference.label}</span>
        <span className="context-mention-description">{reference.description}</span>
      </span>
    </>
  );
}

export function ContextReferenceChip({ reference }: { reference: Reference }) {
  return (
    <a
      href={reference.href}
      className={contextReferenceClassName(reference.plugin)}
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
