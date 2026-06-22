import { describe, expect, it } from "vitest";
import { areAnyNamesSimilar, areNamesSimilar, levenshtein, normalizeName } from "./similarity";

describe("normalizeName", () => {
  it("lowercases and turns slugs into space-separated tokens", () => {
    expect(normalizeName("aurelio-anastassiades")).toBe("aurelio anastassiades");
    expect(normalizeName("Aurelio Anastassiades")).toBe("aurelio anastassiades");
  });

  it("transliterates German umlauts and ß the way people spell them around", () => {
    expect(normalizeName("Müller")).toBe("mueller");
    expect(normalizeName("Mueller")).toBe("mueller");
    expect(normalizeName("Grünberg")).toBe("gruenberg");
    expect(normalizeName("Straße")).toBe("strasse");
  });

  it("strips other diacritics", () => {
    expect(normalizeName("José")).toBe("jose");
    expect(normalizeName("Renée")).toBe("renee");
  });

  it("collapses punctuation and whitespace runs", () => {
    expect(normalizeName("  Acme,   Inc.  ")).toBe("acme inc");
    expect(normalizeName("O'Brien")).toBe("o brien");
  });

  it("returns empty string for blank input", () => {
    expect(normalizeName("   ")).toBe("");
    expect(normalizeName("!!!")).toBe("");
  });
});

describe("levenshtein", () => {
  it("computes edit distance", () => {
    expect(levenshtein("gruenberg", "grueneberg")).toBe(1);
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("areNamesSimilar — true cases", () => {
  it("matches a name that is a fuller version of another (token containment)", () => {
    // The reported bug: aurelio.md + aurelio-anastassiades.md
    expect(areNamesSimilar("aurelio", "aurelio-anastassiades")).toBe(true);
    expect(areNamesSimilar("aurelio-anastassiades", "aurelio")).toBe(true);
    // The skill's own merge example.
    expect(areNamesSimilar("acme", "acme-corp")).toBe(true);
  });

  it("matches single-character spelling variants of long names", () => {
    // The reported bug: christian-gruenberg.md + christian-grueneberg.md
    expect(areNamesSimilar("christian-gruenberg", "christian-grueneberg")).toBe(true);
    expect(areNamesSimilar("Aurelio Anastassiades", "Aurelio Anastasiades")).toBe(true);
  });

  it("matches across umlaut spellings", () => {
    expect(areNamesSimilar("Christian Müller", "Christian Mueller")).toBe(true);
  });

  it("matches case and punctuation variants exactly", () => {
    expect(areNamesSimilar("Aurelio Anastassiades", "aurelio anastassiades")).toBe(true);
    expect(areNamesSimilar("Acme, Inc.", "acme inc")).toBe(true);
  });

  it("is order-independent for multi-token names", () => {
    expect(areNamesSimilar("Aurelio Anastassiades", "Anastassiades Aurelio")).toBe(true);
  });

  it("matches a bare surname against the full name", () => {
    expect(areNamesSimilar("Anastassiades", "Aurelio Anastassiades")).toBe(true);
  });
});

describe("areNamesSimilar — per-token edit budget boundaries", () => {
  it("tolerates one edit for medium tokens (>= 6 chars)", () => {
    expect(areNamesSimilar("daniel", "daniol")).toBe(true); // len 6, distance 1
  });

  it("tolerates two edits only for long tokens (>= 10 chars)", () => {
    expect(areNamesSimilar("aleksander", "aleksandra")).toBe(true); // len 10, distance 2
    expect(areNamesSimilar("alexandr", "aleksandr")).toBe(false); // len 8, distance 2 — over budget
  });

  it("tolerates no edits below the fuzzy floor (< 6 chars)", () => {
    expect(areNamesSimilar("thomas", "tomas")).toBe(false); // shorter token len 5, distance 1
    expect(areNamesSimilar("susan", "sucan")).toBe(false); // len 5, distance 1
  });
});

describe("areNamesSimilar — false cases (precision guards)", () => {
  it("does not match short distinct names that happen to be one edit apart", () => {
    expect(areNamesSimilar("ben", "ken")).toBe(false);
    expect(areNamesSimilar("anna", "anya")).toBe(false);
    expect(areNamesSimilar("jon", "tom")).toBe(false);
  });

  it("does not match plainly different names", () => {
    expect(areNamesSimilar("john-smith", "jane-doe")).toBe(false);
    expect(areNamesSimilar("acme", "globex")).toBe(false);
    expect(areNamesSimilar("Aurelio Anastassiades", "Christian Gruenberg")).toBe(false);
  });

  it("does not match different people who share only a surname", () => {
    expect(areNamesSimilar("Christian Mueller", "Sebastian Mueller")).toBe(false);
  });

  it("does not fuse different people who share a surname and differ by a short first name", () => {
    // These all differ by only 1-2 characters TOTAL, but the difference is in a short
    // discriminating token — they are distinct people, not spelling variants.
    expect(areNamesSimilar("Mario Lopez", "Maria Lopez")).toBe(false);
    expect(areNamesSimilar("Carl Berg", "Karl Berg")).toBe(false);
    expect(areNamesSimilar("Hans Gruber", "Hans Huber")).toBe(false);
    expect(areNamesSimilar("Stefan Mueller", "Stephan Mueller")).toBe(false);
    expect(areNamesSimilar("amy-chen", "amy-shen")).toBe(false);
    expect(areNamesSimilar("Erik Larsson", "Erik Larsen")).toBe(false);
  });

  it("does not fuse companies that share a brand but differ in legal suffix", () => {
    expect(areNamesSimilar("Allianz SE", "Allianz AG")).toBe(false);
  });

  it("does not match on a single short shared token", () => {
    // "li" is too short to be a confident shared token.
    expect(areNamesSimilar("li", "li-wei")).toBe(false);
  });

  it("never matches blank names", () => {
    expect(areNamesSimilar("", "aurelio")).toBe(false);
    expect(areNamesSimilar("aurelio", "")).toBe(false);
  });
});

describe("areAnyNamesSimilar", () => {
  it("matches when any name pairing is similar", () => {
    // title vs alias hit
    expect(
      areAnyNamesSimilar(
        ["Aurelio Anastassiades", "aurelio-anastassiades"],
        ["Aurelio", "aurelio"],
      ),
    ).toBe(true);
  });

  it("returns false when no pairing is similar", () => {
    expect(areAnyNamesSimilar(["Aurelio Anastassiades"], ["Christian Gruenberg", "chris"])).toBe(
      false,
    );
  });

  it("returns false for empty lists", () => {
    expect(areAnyNamesSimilar([], ["aurelio"])).toBe(false);
    expect(areAnyNamesSimilar(["aurelio"], [])).toBe(false);
  });
});
