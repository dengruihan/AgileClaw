import JSZip from "jszip";

/** Deterministic synthetic OOXML fixtures; no real Office file is ever read. */
export type OfficeFixtureFile = { path: string; content: string | Buffer };

/** Extra package part used to prove a relationship target is never read. */
export type OfficeFixtureRelationship = {
  id: string;
  target: string;
  type?: string;
  targetMode?: "External";
};

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

function relationships(
  entries: readonly {
    id: string;
    type?: string;
    target: string;
    targetMode?: "External";
  }[],
): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELATIONSHIPS_NS}">
${entries
  .map(
    (entry) =>
      `  <Relationship Id="${entry.id}" Type="${entry.type ?? `${OFFICE_REL_NS}/worksheet`}" Target="${entry.target}"${
        entry.targetMode ? ` TargetMode="${entry.targetMode}"` : ""
      }/>`,
  )
  .join("\n")}
</Relationships>`;
}

export type XlsxFixtureSheet = {
  name: string;
  rows?: readonly (readonly {
    column: string;
    value: string;
    type?: "s" | "inlineStr" | "b";
  }[])[];
  /** Raw `<sheetData>` body, for malformed or sparse row-number regressions. */
  sheetDataXml?: string;
  /** XML inserted before `<sheetData>` (sheetViews, cols, merges, ...). */
  worksheetPrefixXml?: string;
  /** Worksheet tab visibility declared by the workbook part. */
  state?: "hidden" | "veryHidden";
};

function worksheetContent(prefixXml: string, sheetDataXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${prefixXml}<sheetData>${sheetDataXml}</sheetData></worksheet>`;
}

function generatedSheetData(sheet: XlsxFixtureSheet): string {
  return (sheet.rows ?? [])
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
}

export async function buildXlsxFixture(options?: {
  sheets?: readonly XlsxFixtureSheet[];
  sharedStrings?: readonly string[];
  /** Sheet declarations without a packaged worksheet part. */
  linkedSheets?: readonly { name: string; relationshipId: string }[];
  /** Relationships appended to the workbook part, including external targets. */
  workbookRelationships?: readonly OfficeFixtureRelationship[];
  extraParts?: readonly OfficeFixtureFile[];
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
  const linkedSheets = options?.linkedSheets ?? [];

  const sheetXml = sheets.map((sheet, sheetIndex) => ({
    path: `xl/worksheets/sheet${sheetIndex + 1}.xml`,
    content: worksheetContent(
      sheet.worksheetPrefixXml ?? "",
      sheet.sheetDataXml ?? generatedSheetData(sheet),
    ),
  }));

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
      content: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE_REL_NS}"><sheets>${[
        ...sheets.map(
          (sheet, index) =>
            `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"${
              sheet.state ? ` state="${sheet.state}"` : ""
            }/>`,
        ),
        ...linkedSheets.map(
          (sheet, index) =>
            `<sheet name="${sheet.name}" sheetId="${sheets.length + index + 1}" r:id="${sheet.relationshipId}"/>`,
        ),
      ].join("")}</sheets></workbook>`,
    },
    {
      path: "xl/_rels/workbook.xml.rels",
      content: relationships([
        ...sheets.map((_, index) => ({
          id: `rId${index + 1}`,
          target:
            index === sheets.length - 1
              ? `/xl/worksheets/sheet${index + 1}.xml`
              : `worksheets/sheet${index + 1}.xml`,
        })),
        ...(options?.workbookRelationships ?? []),
      ]),
    },
    {
      path: "xl/sharedStrings.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sharedStrings
        .map((value) => `<si><t>${value}</t></si>`)
        .join("")}</sst>`,
    },
    ...sheetXml,
    ...(options?.extraParts ?? []),
  ]);
}

export async function buildDocxFixture(
  elementXml?: string,
  options?: {
    /** Relationships appended to the document part, including external targets. */
    documentRelationships?: readonly OfficeFixtureRelationship[];
    /** Word styles part used to prove default/basedOn chain resolution. */
    stylesXml?: string;
    extraParts?: readonly OfficeFixtureFile[];
  },
): Promise<Buffer> {
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
      content: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${OFFICE_REL_NS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${body}</w:body></w:document>`,
    },
    ...(options?.stylesXml ? [{ path: "word/styles.xml", content: options.stylesXml }] : []),
    ...(options?.documentRelationships
      ? [
          {
            path: "word/_rels/document.xml.rels",
            content: relationships(
              options.documentRelationships.map((entry) => ({
                id: entry.id,
                target: entry.target,
                ...(entry.type ? { type: entry.type } : {}),
                ...(entry.targetMode ? { targetMode: entry.targetMode } : {}),
              })),
            ),
          },
        ]
      : []),
    ...(options?.extraParts ?? []),
  ]);
}

export function buildSlideXml(title: string, lines: readonly string[]): string {
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
  options?: {
    /** Slide ids appended to the slide list without a packaged slide part. */
    linkedSlides?: readonly { id: number; relationshipId: string }[];
    /** Relationships appended to the presentation part, including external targets. */
    presentationRelationships?: readonly OfficeFixtureRelationship[];
    extraParts?: readonly OfficeFixtureFile[];
  },
): Promise<Buffer> {
  const linkedSlides = options?.linkedSlides ?? [];
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
      content: `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${OFFICE_REL_NS}"><p:sldIdLst>${[
        ...slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`),
        ...linkedSlides.map(
          (slide) => `<p:sldId id="${slide.id}" r:id="${slide.relationshipId}"/>`,
        ),
      ].join("")}</p:sldIdLst></p:presentation>`,
    },
    {
      path: "ppt/_rels/presentation.xml.rels",
      content: relationships([
        ...slides.map((_, index) => ({
          id: `rId${index + 2}`,
          type: `${OFFICE_REL_NS}/slide`,
          target: `slides/slide${index + 1}.xml`,
        })),
        ...(options?.presentationRelationships ?? []),
      ]),
    },
    ...slides.map((slide, index) => ({
      path: `ppt/slides/slide${index + 1}.xml`,
      content: buildSlideXml(slide.title, slide.lines),
    })),
    ...(options?.extraParts ?? []),
  ]);
}

/** Legacy OLE compound-file header, as produced by .xls/.doc/.ppt. */
export const OLE_COMPOUND_FILE_HEADER = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);
/** 1x1 transparent PNG used to prove bounded inline image support. */
export const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const THEME_COLOR_SCHEME = `<a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2>
<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1>
<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
<a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
<a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink>
<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>`;

/** Minimal Office theme with accent slots and major/minor fonts. */
export const OFFICE_THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">
<a:themeElements>${THEME_COLOR_SCHEME}
<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme>
</a:themeElements>
</a:theme>`;

const XLSX_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="$#,##0.00"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4" tint="0.79998168889431442"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;

const STYLED_XLSX_SHEET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><tabColor rgb="FF3300CC"/></sheetPr>
<sheetViews><sheetView showGridLines="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" state="frozen"/></sheetView></sheetViews>
<cols><col min="1" max="1" width="30" customWidth="1"/><col min="2" max="2" width="16" customWidth="1"/><col min="3" max="3" width="16" customWidth="1"/><col min="4" max="4" width="9" hidden="1"/></cols>
<sheetData>
<row r="1" ht="30" customHeight="1"><c r="A1" s="1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" s="1" t="inlineStr"><is><t>Cost</t></is></c><c r="C1" s="1" t="inlineStr"><is><t>Date</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>Rent</t></is></c><c r="B2" s="2"><v>1200.5</v></c><c r="C2" s="3"><v>45306</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>Share</t></is></c><c r="B3"><v>0.125</v></c></row>
</sheetData>
<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>
<conditionalFormatting sqref="B2"><cfRule type="cellIs" priority="1"/></conditionalFormatting>
<dataValidations count="1"><dataValidation type="list" sqref="A2"/></dataValidations>
</worksheet>`;

/** Styled workbook covering widths, heights, styles, merges, panes, and formats. */
export async function buildStyledXlsxFixture(): Promise<Buffer> {
  return await buildZip([
    {
      path: "[Content_Types].xml",
      content: contentTypes([
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
      ]),
    },
    {
      path: "_rels/.rels",
      content: relationships([
        { id: "rId1", type: `${OFFICE_REL_NS}/officeDocument`, target: "xl/workbook.xml" },
      ]),
    },
    {
      path: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OFFICE_REL_NS}"><workbookPr date1904="0"/><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
    },
    {
      path: "xl/_rels/workbook.xml.rels",
      content: relationships([
        { id: "rId1", target: "worksheets/sheet1.xml" },
        { id: "rId2", target: "worksheets/sheet2.xml" },
      ]),
    },
    {
      path: "xl/sharedStrings.xml",
      content: `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>`,
    },
    { path: "xl/theme/theme1.xml", content: OFFICE_THEME_XML },
    { path: "xl/styles.xml", content: XLSX_STYLES_XML },
    { path: "xl/worksheets/sheet1.xml", content: STYLED_XLSX_SHEET_XML },
    {
      path: "xl/worksheets/sheet2.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hidden tab</t></is></c></row></sheetData></worksheet>`,
    },
    { path: "xl/drawings/drawing1.xml", content: "<xdr:wsDr/>" },
    { path: "xl/charts/chart1.xml", content: "<c:chartSpace/>" },
    { path: "xl/pivotTables/pivotTable1.xml", content: "<pivotTableDefinition/>" },
    { path: "xl/comments1.xml", content: "<comments/>" },
  ]);
}

const DOCX_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/><w:color w:val="000000"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia"/><w:b/><w:sz w:val="48"/><w:color w:val="1F3864"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

const DOCX_NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

function docxDrawingXml(params: {
  relationshipId: string;
  description: string;
  sizeEmu: number;
  anchor?: boolean;
}): string {
  const container = params.anchor ? "wp:anchor" : "wp:inline";
  return `<w:drawing><${container}><wp:extent cx="${params.sizeEmu}" cy="${params.sizeEmu}"/><wp:docPr id="1" name="Picture 1" descr="${params.description}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="${params.relationshipId}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></${container}></w:drawing>`;
}

function styledDocxBody(): string {
  return `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Quarterly Layout</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Plain </w:t></w:r><w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t>bold red</w:t></w:r><w:r><w:rPr><w:rStyle w:val="Strong"/><w:i/></w:rPr><w:t xml:space="preserve"> strong italic</w:t></w:r><w:r><w:rPr><w:rFonts w:asciiTheme="minorHAnsi"/></w:rPr><w:t xml:space="preserve"> theme font</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Section Two</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First numbered</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Second numbered</w:t></w:r></w:p>
<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>
<w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/></w:tcPr><w:p><w:r><w:t>Header A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Header B</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Merged</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>B3</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r>${docxDrawingXml({ relationshipId: "rIdImage", description: "Synthetic logo", sizeEmu: 952500 })}</w:r></w:p>
<w:p><w:r>${docxDrawingXml({ relationshipId: "rIdEmf", description: "Unsupported metafile", sizeEmu: 952500 })}</w:r></w:p>
<w:p><w:r><w:drawing><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rIdChart"/></a:graphicData></a:graphic></w:drawing></w:r></w:p>
<w:p><w:r><w:drawing><wp:anchor><wp:extent cx="952500" cy="952500"/><wp:docPr id="2" name="Text Box" descr="Floating note"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:txbx><w:txbxContent><w:p><w:r><w:t>Floating note</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>
<w:p><w:r><m:oMath/></w:r></w:p>
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
<w:p><w:r><w:t>Page two text</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:rFonts w:asciiTheme="majorHAnsi"/></w:rPr><w:t>Split before</w:t><w:lastRenderedPageBreak/><w:t>after break</w:t></w:r></w:p>
<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
}

/** Styled document covering pages, styles, runs, lists, tables, images, and parts. */
export async function buildStyledDocxFixture(): Promise<Buffer> {
  return await buildZip([
    {
      path: "[Content_Types].xml",
      content: contentTypes([
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        '<Default Extension="png" ContentType="image/png"/>',
        '<Default Extension="emf" ContentType="image/x-emf"/>',
      ]),
    },
    {
      path: "_rels/.rels",
      content: relationships([
        { id: "rId1", type: `${OFFICE_REL_NS}/officeDocument`, target: "word/document.xml" },
      ]),
    },
    { path: "word/styles.xml", content: DOCX_STYLES_XML },
    { path: "word/numbering.xml", content: DOCX_NUMBERING_XML },
    { path: "word/theme/theme1.xml", content: OFFICE_THEME_XML },
    {
      path: "word/document.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${OFFICE_REL_NS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>${styledDocxBody()}</w:body></w:document>`,
    },
    {
      path: "word/_rels/document.xml.rels",
      content: relationships([
        {
          id: "rIdImage",
          type: `${OFFICE_REL_NS}/image`,
          target: "media/image1.png",
        },
        { id: "rIdEmf", type: `${OFFICE_REL_NS}/image`, target: "media/image2.emf" },
        { id: "rIdChart", type: `${OFFICE_REL_NS}/chart`, target: "charts/chart1.xml" },
        { id: "rIdHeader", type: `${OFFICE_REL_NS}/header`, target: "header1.xml" },
        { id: "rIdFooter", type: `${OFFICE_REL_NS}/footer`, target: "footer1.xml" },
      ]),
    },
    {
      path: "word/header1.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>Confidential</w:t></w:r></w:p></w:hdr>`,
    },
    {
      path: "word/footer1.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Page footer</w:t></w:r></w:p></w:ftr>`,
    },
    { path: "word/media/image1.png", content: Buffer.from(PNG_1X1_BASE64, "base64") },
    { path: "word/media/image2.emf", content: Buffer.from([0x01, 0x00, 0x00, 0x00]) },
    { path: "word/charts/chart1.xml", content: "<c:chartSpace/>" },
  ]);
}
/** Handcrafted ZIP whose only entry has the encrypted flag set. */
export function buildEncryptedZipFixture(entryName = "word/document.xml"): Buffer {
  const name = Buffer.from(entryName, "utf8");
  const payload = Buffer.from("encrypted");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(1, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(1, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const centralDirectory = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(local.length + name.length + payload.length, 16);
  return Buffer.concat([local, name, payload, centralDirectory, end]);
}

/** ECMA-376 encrypted package: OLE container holding an EncryptedPackage stream. */
export function buildEncryptedOoxmlContainer(): Buffer {
  return Buffer.concat([
    OLE_COMPOUND_FILE_HEADER,
    Buffer.from("EncryptedPackage", "utf16le"),
    Buffer.alloc(64),
  ]);
}

/** A signature-valid PNG padded to a requested byte size. */
export function paddedPng(bytes: number): Buffer {
  const base = Buffer.from(PNG_1X1_BASE64, "base64");
  return bytes <= base.length
    ? base
    : Buffer.concat([base, Buffer.alloc(bytes - base.length, 0x41)]);
}

/** Document repeating one image part so payload growth per occurrence is measurable. */
export async function buildRepeatedImageDocxFixture(params: {
  imageBytes: number;
  occurrences: number;
}): Promise<Buffer> {
  const image = paddedPng(params.imageBytes);
  const drawing = `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="Repeated" descr="Repeated image"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdImage"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  return await buildDocxFixture(drawing.repeat(params.occurrences), {
    documentRelationships: [
      {
        id: "rIdImage",
        type: `${OFFICE_REL_NS}/image`,
        target: "media/repeated.png",
      },
    ],
    extraParts: [{ path: "word/media/repeated.png", content: image }],
  });
}

/** ZIP with more entries than the preview archive budget allows. */
export async function buildEntryOverflowZipFixture(entries = 2_001): Promise<Buffer> {
  return await buildZip(
    Array.from({ length: entries }, (_, index) => ({
      path: `part-${index}.xml`,
      content: "<x/>",
    })),
  );
}

/** Text-box shapes in the three forms Word writes. */
export function textBoxDocxBody(params: {
  text: string;
  form: "inline" | "anchor" | "vml";
}): string {
  const content = `<w:txbxContent><w:p><w:r><w:t>${params.text}</w:t></w:r></w:p></w:txbxContent>`;
  if (params.form === "vml") {
    return `<w:p><w:r><w:pict><v:shape><v:textbox>${content}</v:textbox></v:shape></w:pict></w:r></w:p>`;
  }
  const container = params.form === "anchor" ? "wp:anchor" : "wp:inline";
  return `<w:p><w:r><w:drawing><${container}><wp:extent cx="952500" cy="952500"/><wp:docPr id="3" name="Text Box"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wps:wsp><wps:txbx>${content}</wps:txbx></wps:wsp></a:graphicData></a:graphic></${container}></w:drawing></w:r></w:p>`;
}

/** Deterministic low-compressibility text for budget probes. */
export function incompressibleText(length: number, seed: number): string {
  let state = seed >>> 0;
  let text = "";
  for (let index = 0; index < length; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    text += String.fromCharCode(97 + (state % 26));
  }
  return text;
}
