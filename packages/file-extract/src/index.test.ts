import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DocumentExtractionError, extractDocumentMarkdown, extractUtf8Text } from "./index";

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

describe("extractDocumentMarkdown", () => {
  it("extracts DOCX as Markdown", async () => {
    const result = await extractDocumentMarkdown({
      bytes: fixture("sample.docx"),
      filename: "sample.docx",
    });
    expect(result.format).toBe("docx");
    expect(result.truncated).toBe(false);
    expect(result.markdown).toContain("Quarterly Report");
    expect(result.markdown).toContain("Revenue grew to 120");
  });

  it("extracts XLSX as a Markdown table", async () => {
    const result = await extractDocumentMarkdown({
      bytes: fixture("sample.xlsx"),
      filename: "sample.xlsx",
    });
    expect(result.format).toBe("xlsx");
    expect(result.markdown).toContain("| metric | value |");
    expect(result.markdown).toContain("| revenue | 120 |");
  });

  it("extracts text-based PDF as Markdown", async () => {
    const result = await extractDocumentMarkdown({
      bytes: fixture("sample.pdf"),
      filename: "sample.pdf",
    });
    expect(result.format).toBe("pdf");
    expect(result.markdown).toContain("Contract Summary");
  });

  it("detects the format from bytes even when the filename lies", async () => {
    // A DOCX handed over with a .txt name must still be parsed as DOCX, not decoded as text.
    const result = await extractDocumentMarkdown({
      bytes: fixture("sample.docx"),
      filename: "notes.txt",
    });
    expect(result.format).toBe("docx");
    expect(result.markdown).toContain("Quarterly Report");
  });

  it("renders CSV as a Markdown table using the filename hint", async () => {
    const result = await extractDocumentMarkdown({
      bytes: Buffer.from("metric,value\nrevenue,120\n"),
      filename: "figures.csv",
    });
    expect(result.format).toBe("csv");
    expect(result.markdown).toContain("| metric | value |");
    expect(result.markdown).toContain("| revenue | 120 |");
  });

  it("passes plain text and Markdown through the UTF-8 path", async () => {
    const result = await extractDocumentMarkdown({
      bytes: Buffer.from("# Title\n\nHello **world**."),
      mediaType: "text/markdown",
    });
    expect(result.format).toBe("text");
    expect(result.markdown).toBe("# Title\n\nHello **world**.");
  });

  it("reports a scanned/image-only PDF as image_only_pdf", async () => {
    await expect(
      extractDocumentMarkdown({ bytes: fixture("image-only.pdf"), filename: "scan.pdf" }),
    ).rejects.toMatchObject({ kind: "image_only_pdf" });
  });

  it("reports malformed documents", async () => {
    await expect(
      extractDocumentMarkdown({
        bytes: Buffer.from("%PDF-1.7\nnot a real pdf\n"),
        filename: "broken.pdf",
      }),
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("reports unsupported input when nothing identifies a format", async () => {
    const error = await extractDocumentMarkdown({
      bytes: Buffer.from([0x00, 0x01, 0x02, 0x03]),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(DocumentExtractionError);
    expect(error.kind).toBe("unsupported");
  });

  it("rejects invalid UTF-8 on the text path as malformed", async () => {
    await expect(
      extractDocumentMarkdown({ bytes: Buffer.from([0xff, 0xfe, 0xfd]), mediaType: "text/plain" }),
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("caps output at maxOutputBytes and flags truncation", async () => {
    const bytes = Buffer.from(`col\n${"x".repeat(5_000)}\n`);
    const result = await extractDocumentMarkdown({
      bytes,
      filename: "big.csv",
      maxOutputBytes: 500,
    });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.markdown, "utf8")).toBeLessThanOrEqual(500);
  });
});

describe("extractUtf8Text", () => {
  it("decodes and caps UTF-8 text", () => {
    const text = extractUtf8Text(Buffer.from(`hello ${"é".repeat(20)}`), { maxBytes: 20 });
    expect(text).toContain("hello");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(20);
    expect(text).not.toContain("�");
  });

  it("rejects invalid UTF-8", () => {
    expect(() => extractUtf8Text(Buffer.from([0xff, 0xfe]))).toThrow();
  });
});
