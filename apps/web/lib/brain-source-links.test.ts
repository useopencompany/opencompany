import { describe, expect, it } from "vitest";
import { isExternalHref, sourceChipDisplay, sourceHrefForRef } from "@/lib/brain-source-links";

describe("sourceHrefForRef", () => {
  it("derives GitHub URLs from activity source refs", () => {
    expect(sourceHrefForRef("github:acme/api")).toBe("https://github.com/acme/api");
    expect(sourceHrefForRef("github:acme/api:pull:123")).toBe(
      "https://github.com/acme/api/pull/123",
    );
    expect(sourceHrefForRef("github:acme/api:issue:45")).toBe(
      "https://github.com/acme/api/issues/45",
    );
    expect(sourceHrefForRef("github:acme/api:issue:45:comment:987654321")).toBe(
      "https://github.com/acme/api/issues/45#issuecomment-987654321",
    );
    expect(sourceHrefForRef("github:acme/api:pull:45:comment:987654321")).toBe(
      "https://github.com/acme/api/pull/45#issuecomment-987654321",
    );
  });

  it("supports direct http source ids and upload assets", () => {
    expect(sourceHrefForRef("web:https://example.com/docs/a?b=1")).toBe(
      "https://example.com/docs/a?b=1",
    );
    expect(sourceHrefForRef("upload:goat_brain_doc_abc")).toBe(
      "/v1/brain-assets/goat_brain_doc_abc",
    );
  });

  it("resolves linear, gmail, slack, drive, hubspot, and fathom refs", () => {
    expect(sourceHrefForRef("linear:issue:ENG-42")).toBe("https://linear.app/issue/ENG-42");
    expect(sourceHrefForRef("gmail:thread:18c2a4b9d0e1f234")).toBe(
      "https://mail.google.com/mail/u/0/#all/18c2a4b9d0e1f234",
    );
    expect(sourceHrefForRef("slack:conversation:T0AB12CD3:C0XY98ZW7:1754500000.000100")).toBe(
      "https://app.slack.com/client/T0AB12CD3/C0XY98ZW7",
    );
    expect(sourceHrefForRef("google-drive:file:1AbC_dEf-234567890xyz")).toBe(
      "https://drive.google.com/open?id=1AbC_dEf-234567890xyz",
    );
    expect(sourceHrefForRef("hubspot:12345678:deal:9876543")).toBe(
      "https://app.hubspot.com/contacts/12345678/record/0-3/9876543",
    );
    expect(sourceHrefForRef("fathom:recording:8842197")).toBe("https://fathom.video/calls/8842197");
  });

  it("rejects malformed provider ids instead of guessing", () => {
    expect(sourceHrefForRef("linear:issue:not an id")).toBeNull();
    expect(sourceHrefForRef("gmail:thread:x")).toBeNull();
    expect(sourceHrefForRef("slack:conversation:evil:C0XY98ZW7:1")).toBeNull();
    expect(sourceHrefForRef("hubspot:12345678:ticket:1")).toBeNull();
    expect(sourceHrefForRef("google-drive:file:short")).toBeNull();
  });

  it("resolves pointer-only and internal refs", () => {
    expect(sourceHrefForRef("granola:note:note_1")).toBe("https://app.granola.ai/notes/note_1");
    // Jamie and Attio have no stable per-artifact URL, so the chip stays inert.
    expect(sourceHrefForRef("jamie:meeting:calendar_event_123")).toBeNull();
    expect(sourceHrefForRef("attio:ws_1:deal:rec_9876")).toBeNull();
  });

  it("names the artifact when the author wrote no label of their own", () => {
    expect(sourceChipDisplay("linear:issue:ENG-42", "linear:issue:ENG-42")).toEqual({
      icon: "link",
      label: "ENG-42",
    });
    expect(
      sourceChipDisplay("gmail:thread:18c2a4b9d0e1f234", "gmail:thread:18c2a4b9d0e1f234"),
    ).toEqual({
      icon: "link",
      label: "Gmail thread",
    });
    expect(sourceChipDisplay("github:acme/api:pull:123", "github:acme/api:pull:123")).toEqual({
      icon: "github",
      label: "#123",
    });
    expect(sourceChipDisplay("jamie:meeting:evt_1", "jamie:meeting:evt_1")).toEqual({
      icon: "link",
      label: "Jamie meeting",
    });
  });

  it("keeps an author-written label, and the raw ref when nothing can place it", () => {
    expect(sourceChipDisplay("linear:issue:ENG-42", "Custom label")).toEqual({
      icon: "link",
      label: "Custom label",
    });
    expect(sourceChipDisplay("github:acme/api:pull:123", "Rollout PR")).toEqual({
      icon: "github",
      label: "Rollout PR",
    });
    expect(sourceChipDisplay("notion:page-1", "notion:page-1")).toEqual({
      icon: "link",
      label: "notion:page-1",
    });
  });

  it("does not create links for unsafe or under-specified refs", () => {
    expect(sourceHrefForRef("web:javascript:alert(1)")).toBeNull();
    expect(sourceHrefForRef("github:acme/api:pull:nope")).toBeNull();
    expect(sourceHrefForRef("github:bad/../../repo:issue:1")).toBeNull();
    expect(sourceHrefForRef("not-a-source-ref")).toBeNull();
  });
});

describe("isExternalHref", () => {
  it("distinguishes external http URLs from app paths", () => {
    expect(isExternalHref("https://github.com/acme/api")).toBe(true);
    expect(isExternalHref("http://example.com")).toBe(true);
    expect(isExternalHref("/v1/brain-assets/doc_1")).toBe(false);
  });
});
