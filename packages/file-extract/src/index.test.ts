import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { extractUtf8Text, extractXlsxText } from "./index";

async function workbookBytes(build: (workbook: ExcelJS.Workbook) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("extractXlsxText", () => {
  it("renders sheets as headed CSV blocks", async () => {
    const bytes = await workbookBytes((workbook) => {
      const sheet = workbook.addWorksheet("Q1");
      sheet.addRow(["metric", "value"]);
      sheet.addRow(["revenue", 120]);
      sheet.addRow(["notes", 'said "up", strongly']);
    });
    const text = await extractXlsxText(bytes);
    expect(text).toContain("## Sheet: Q1");
    expect(text).toContain("metric,value");
    expect(text).toContain("revenue,120");
    // Quotes and commas get CSV-escaped.
    expect(text).toContain('"said ""up"", strongly"');
  });

  it("caps the output size with a truncation marker", async () => {
    const bytes = await workbookBytes((workbook) => {
      const sheet = workbook.addWorksheet("Big");
      for (let index = 0; index < 200; index += 1) {
        sheet.addRow([`row-${index}`, "x".repeat(50)]);
      }
    });
    const text = await extractXlsxText(bytes, { maxBytes: 500 });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(1000);
    expect(text).toContain("truncated");
  });
});

describe("extractUtf8Text", () => {
  it("decodes and caps UTF-8 text", () => {
    const text = extractUtf8Text(
      Buffer.from(`1\n00:00:00,000 --> 00:00:01,000\n${"é".repeat(20)}`),
      {
        maxBytes: 50,
      },
    );
    expect(text).toContain("00:00:00,000 --> 00:00:01,000");
    expect(text).toContain("truncated");
    expect(text).not.toContain("�");
  });

  it("rejects invalid UTF-8", () => {
    expect(() => extractUtf8Text(Buffer.from([0xff, 0xfe]))).toThrow();
  });
});
