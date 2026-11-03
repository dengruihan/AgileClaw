import JSZip from "jszip";

/** Deterministic synthetic OOXML fixtures; no real Office file is ever read. */
export type OfficeFixtureFile = { path: string; content: string | Buffer };

export async function buildZip(files: readonly OfficeFixtureFile[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.path, file.content);
  }
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function contentTypes(overrides: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${overrides.join("\n  ")}
</Types>`;
}

function relationships(entries: readonly { id: string; type: string; target: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELATIONSHIPS_NS}">
${entries
  .map(
    (entry) => `  <Relationship Id="${entry.id}" Type="${entry.type}" Target="${entry.target}"/>`,
  )
  .join("\n")}
</Relationships>`;
}

export async function buildXlsxFixture(options?: {
  sheets?: readonly {
    name: string;
    rows: readonly (readonly { column: string; value: string; type?: "s" | "inlineStr" | "b" }[])[];
  }[];
  sharedStrings?: readonly string[];
}): Promise<Buffer> {
  const sheets = options?.sheets ?? [
    {
      name: "Budget",
      rows: [
        [
          { column: "A", value: "0", type: "s" as const },
          { column: "B", value: "1", type: "s" as const },
        ],
        [
          { column: "A", value: "Rent", type: "inlineStr" as const },
          { column: "B", value: "1200" },
        ],
        [
          { column: "A", value: "0.5" },
          { column: "C", value: "1", type: "b" as const },
        ],
      ],
    },
    { name: "Notes", rows: [[{ column: "A", value: "2", type: "s" as const }]] },
  ];
  const sharedStrings = options?.sharedStrings ?? ["Item", "Cost", "Hello "];

  const sheetXml = sheets.map((sheet, sheetIndex) => {
    const rows = sheet.rows
      .map((row, rowIndex) => {
        const cells = row
          .map((cell) => {
            const reference = `${cell.column}${rowIndex + 1}`;
            if (cell.type === "s") {
              return `<c r="${reference}" t="s"><v>${cell.value}</v></c>`;
            }
            if (cell.type === "inlineStr") {
              return `<c r="${reference}" t="inlineStr"><is><t>${cell.value}</t></is></c>`;
            }
            if (cell.type === "b") {
              return `<c r="${reference}" t="b"><v>${cell.value}</v></c>`;
            }
            return `<c r="${reference}"><v>${cell.value}</v></c>`;
          })
          .join("");
        return `<row r="${rowIndex + 1}">${cells}</row>`;
      })
      .join("");
    return {
      path: `xl/worksheets/sheet${sheetIndex + 1}.xml`,
      content: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    };
  });

  return await buildZip([
    {
      path: "[Content_Types].xml",
      content: contentTypes([
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        ...sheets.map(
          (_, index) =>
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        ),
      ]),
    },
    {
      path: "_rels/.rels",
      content: relationships([
        {
          id: "rId1",
          type: `${OFFICE_REL_NS}/officeDocument`,
          target: "xl/workbook.xml",
        },
      ]),
    },
    {
      path: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE_REL_NS}"><sheets>${sheets
        .map(
          (sheet, index) =>
            `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
        )
        .join("")}</sheets></workbook>`,
    },
    {
      path: "xl/_rels/workbook.xml.rels",
      content: relationships(
        sheets.map((_, index) => ({
          id: `rId${index + 1}`,
          type: `${OFFICE_REL_NS}/worksheet`,
          target:
            index === sheets.length - 1
              ? `/xl/worksheets/sheet${index + 1}.xml`
              : `worksheets/sheet${index + 1}.xml`,
        })),
      ),
    },
    {
      path: "xl/sharedStrings.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sharedStrings
        .map((value) => `<si><t>${value}</t></si>`)
        .join("")}</sst>`,
    },
    ...sheetXml,
  ]);
}

export async function buildDocxFixture(elementXml?: string): Promise<Buffer> {
  const body =
    elementXml ??
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Revenue </w:t></w:r><w:r><w:t>grew</w:t></w:r><w:r><w:tab/><w:t>a lot</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First point</w:t></w:r></w:p>
<w:p/>`;
  return await buildZip([
    {
      path: "[Content_Types].xml",
      content: contentTypes([
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
      ]),
    },
    {
      path: "_rels/.rels",
      content: relationships([
        { id: "rId1", type: `${OFFICE_REL_NS}/officeDocument`, target: "word/document.xml" },
      ]),
    },
    {
      path: "word/document.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
  ]);
}

function slideXml(title: string, lines: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
  <p:sp><p:txBody>${lines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;
}

export async function buildPptxFixture(
  slides: readonly { title: string; lines: readonly string[] }[] = [
    { title: "Roadmap", lines: ["Ship previews", "Measure adoption"] },
    { title: "Risks", lines: ["Large workbooks"] },
  ],
): Promise<Buffer> {
  return await buildZip([
    {
      path: "[Content_Types].xml",
      content: contentTypes([
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
      ]),
    },
    {
      path: "_rels/.rels",
      content: relationships([
        { id: "rId1", type: `${OFFICE_REL_NS}/officeDocument`, target: "ppt/presentation.xml" },
      ]),
    },
    {
      path: "ppt/presentation.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${OFFICE_REL_NS}"><p:sldIdLst>${slides
        .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`)
        .join("")}</p:sldIdLst></p:presentation>`,
    },
    {
      path: "ppt/_rels/presentation.xml.rels",
      content: relationships(
        slides.map((_, index) => ({
          id: `rId${index + 2}`,
          type: `${OFFICE_REL_NS}/slide`,
          target: `slides/slide${index + 1}.xml`,
        })),
      ),
    },
    ...slides.map((slide, index) => ({
      path: `ppt/slides/slide${index + 1}.xml`,
      content: slideXml(slide.title, slide.lines),
    })),
  ]);
}

/** Legacy OLE compound-file header, as produced by .xls/.doc/.ppt. */
export const OLE_COMPOUND_FILE_HEADER = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);
