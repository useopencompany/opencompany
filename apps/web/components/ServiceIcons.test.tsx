import { InfisicalIcon, SigNozIcon, SupabaseIcon } from "@opencompany/ui/icons";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("service logos", () => {
  it("keeps gradients and filters local when the same logo appears in multiple slots", () => {
    const { container } = render(
      <>
        {[SupabaseIcon, InfisicalIcon, SigNozIcon].map((Icon, index) => (
          <div key={index}>
            <Icon size={14} />
            <Icon size={24} />
          </div>
        ))}
      </>,
    );
    const ids = Array.from(container.querySelectorAll("[id]"), (node) => node.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);

    for (const svg of container.querySelectorAll("svg")) {
      const localIds = new Set(Array.from(svg.querySelectorAll("[id]"), (node) => node.id));
      const references = Array.from(svg.querySelectorAll("[fill], [filter]"))
        .flatMap((node) => [node.getAttribute("fill"), node.getAttribute("filter")])
        .filter((value): value is string => value?.startsWith("url(#") === true);
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) {
        expect(localIds.has(reference.slice(5, -1))).toBe(true);
      }
    }
  });
});
