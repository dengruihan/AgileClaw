// PPTX fixed-slide regression: slide size, shape transforms, and typography
// must survive the wire so the Control UI can lay slides out once and only scale.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionFileOfficePreviewSchema } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { parseOfficePreviewBuffer } from "./office-preview-parse.js";
import {
  buildPptxFixture,
  buildZip,
  OFFICE_THEME_XML,
  PNG_1X1_BASE64,
  type OfficeFixtureFile,
  type OfficeFixtureRelationship,
} from "./office-preview.test-support.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DGM = "http://schemas.openxmlformats.org/drawingml/2006/diagram";
const CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

function expectValidPreview(preview: unknown) {
  expect(Value.Check(SessionFileOfficePreviewSchema, preview)).toBe(true);
}

function slideRoot(body: string): string {
  return `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" xmlns:dgm="${DGM}" xmlns:c="${CHART}"><p:cSld>${body}</p:cSld></p:sld>`;
}

function spTree(body: string): string {
  return `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree>`;
}

function shape(params: {
  id: number;
  name?: string;
  placeholder?: string;
  idx?: number;
  xfrm?: string;
  fill?: string;
  preset?: string;
  bodyAttributes?: string;
  bodyInner?: string;
  paragraphs?: string;
}): string {
  const placeholder = params.placeholder
    ? `<p:ph type="${params.placeholder}"${params.idx === undefined ? "" : ` idx="${params.idx}"`}/>`
    : "";
  const geometry = params.xfrm ?? "";
  const preset =
    params.preset === undefined
      ? ""
      : `<a:prstGeom prst="${params.preset}"><a:avLst/></a:prstGeom>`;
  const body = params.paragraphs
    ? `<p:txBody><a:bodyPr${params.bodyAttributes ? ` ${params.bodyAttributes}` : ""}>${
        params.bodyInner ?? ""
      }</a:bodyPr><a:lstStyle/>${params.paragraphs}</p:txBody>`
    : "";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${params.id}" name="${params.name ?? "Shape"}"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:spPr>${geometry}${preset}${params.fill ?? ""}</p:spPr>${body}</p:sp>`;
}

function run(text: string, attributes = "", inner = ""): string {
  const properties =
    attributes || inner
      ? `<a:rPr lang="en-US"${attributes ? ` ${attributes}` : ""}>${inner}</a:rPr>`
      : "";
  return `<a:r>${properties}<a:t>${text}</a:t></a:r>`;
}

const LAYOUT_TITLE_XFRM = `<a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm>`;
const LAYOUT_BODY_XFRM = `<a:xfrm><a:off x="838200" y="1825625"/><a:ext cx="10515600" cy="4351338"/></a:xfrm>`;

function placeholderTree(): string {
  return `${shape({ id: 2, name: "Title", placeholder: "title", xfrm: LAYOUT_TITLE_XFRM, paragraphs: "<a:p/>" })}
${shape({ id: 3, name: "Body", placeholder: "body", idx: 1, xfrm: LAYOUT_BODY_XFRM, paragraphs: "<a:p/>" })}`;
}

const MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld>${spTree(placeholderTree())}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" hlink="hlink" folHlink="folHlink"/><p:txStyles>
<p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle>
<p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="&#8226;"/><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>
<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>
</p:txStyles></p:sldMaster>`;

const LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld>${spTree(placeholderTree())}</p:cSld></p:sldLayout>`;

const NOTES_SHAPE = shape({
  id: 3,
  name: "Notes",
  xfrm: `<a:xfrm><a:off x="1270000" y="2540000"/><a:ext cx="3810000" cy="1270000"/></a:xfrm>`,
  preset: "rect",
  fill: "<a:noFill/>",
  bodyAttributes: 'anchor="t" wrap="square"',
  bodyInner: '<a:normAutofit fontScale="75000" lnSpcReduction="20000"/>',
  paragraphs:
    `<a:p><a:pPr algn="l"><a:buChar char="&#8226;"/></a:pPr>${run(
      "Revenue up",
      'sz="2400" b="1"',
      '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:latin typeface="+mj-lt"/>',
    )}</a:p>` +
    `<a:p><a:pPr algn="ctr"><a:buNone/><a:spcBef><a:spcPts val="600"/></a:spcBef></a:pPr>${run(
      "Second line",
      'sz="1600"',
      '<a:solidFill><a:schemeClr val="accent2"/></a:solidFill>',
    )}</a:p>`,
});

const PANEL_SHAPE = `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Panel"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="635000" y="3810000"/><a:ext cx="2540000" cy="635000"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></a:ln></p:spPr></p:sp>`;

const PICTURE = `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Logo" descr="Synthetic logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="8890000" y="457200"/><a:ext cx="1270000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;

const TABLE_FRAME = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1270000" y="5080000"/><a:ext cx="5080000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="2540000"/><a:gridCol w="2540000"/></a:tblGrid><a:tr h="381000"><a:tc><a:txBody><a:bodyPr/><a:p>${run(
  "Region",
  'sz="1400" b="1"',
)}</a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="D9E2F3"/></a:solidFill><a:lnT w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:lnT></a:tcPr></a:tc><a:tc><a:txBody><a:bodyPr/><a:p>${run(
  "Revenue",
  'sz="1400" b="1"',
)}</a:p></a:txBody><a:tcPr/></a:tc></a:tr><a:tr h="381000"><a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p>${run(
  "Merged total",
)}</a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;

const CHART_FRAME = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="6350000" y="5588000"/><a:ext cx="2540000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="${CHART}"><c:chart r:id="rIdChart"/></a:graphicData></a:graphic></p:graphicFrame>`;

const DIAGRAM_FRAME = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="Diagram"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="6350000" y="3810000"/><a:ext cx="2540000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds r:dm="rIdDm" r:lo="rIdLo" r:qs="rIdQs" r:cs="rIdCs"/></a:graphicData></a:graphic></p:graphicFrame>`;

const GROUP_SHAPE = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="6350000" y="2540000"/><a:ext cx="2540000" cy="2540000"/><a:chOff x="0" y="0"/><a:chExt cx="1270000" cy="1270000"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="10" name="Grouped"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="254000" y="254000"/><a:ext cx="508000" cy="508000"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="70AD47"/></a:solidFill></p:spPr></p:sp></p:grpSp>`;

const ORPHAN_SHAPE = shape({
  id: 11,
  name: "Orphan",
  paragraphs: `<a:p>${run("Lost position")}</a:p>`,
});

const VIDEO_PICTURE = `<p:pic><p:nvPicPr><p:cNvPr id="12" name="Clip"/><p:cNvPicPr/><p:nvPr><a:videoFile r:link="rIdVideo"/></p:nvPr></p:nvPicPr><p:blipFill/><p:spPr><a:xfrm><a:off x="8890000" y="2540000"/><a:ext cx="1270000" cy="762000"/></a:xfrm></p:spPr></p:pic>`;

const SLIDE_ONE_BODY = spTree(
  [
    shape({
      id: 2,
      name: "Title 1",
      placeholder: "ctrTitle",
      bodyAttributes: 'anchor="ctr"',
      paragraphs: `<a:p>${run("Fixed slide title")}</a:p>`,
    }),
    NOTES_SHAPE,
    PANEL_SHAPE,
    PICTURE,
    TABLE_FRAME,
    CHART_FRAME,
    DIAGRAM_FRAME,
    GROUP_SHAPE,
    ORPHAN_SHAPE,
    VIDEO_PICTURE,
  ].join("\n"),
);

const SLIDE_TWO_BODY = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${spTree(
  shape({
    id: 2,
    name: "Closing",
    xfrm: `<a:xfrm><a:off x="635000" y="635000"/><a:ext cx="8890000" cy="1270000"/></a:xfrm>`,
    paragraphs: `<a:p><a:pPr algn="ctr"/>${run(
      "Second slide body",
      'sz="3200"',
      '<a:solidFill><a:schemeClr val="bg1"/></a:solidFill>',
    )}</a:p>`,
  }),
)}`;

function relationshipsXml(entries: readonly OfficeFixtureRelationship[]): string {
  return `<Relationships xmlns="${REL_NS}">${entries
    .map(
      (entry) =>
        `<Relationship Id="${entry.id}" Type="${entry.type ?? `${R}/image`}" Target="${entry.target}"${
          entry.targetMode ? ` TargetMode="${entry.targetMode}"` : ""
        }/>`,
    )
    .join("")}</Relationships>`;
}

async function buildDeckFixture(options?: {
  slideSize?: { cx: number; cy: number } | null;
  slideOneBody?: string;
  extraSlides?: readonly OfficeFixtureFile[];
}): Promise<Buffer> {
  const slideSize =
    options?.slideSize === null
      ? ""
      : `<p:sldSz cx="${options?.slideSize?.cx ?? 12_192_000}" cy="${options?.slideSize?.cy ?? 6_858_000}"/>`;
  return await buildZip([
    {
      path: "ppt/presentation.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">${slideSize}<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>`,
    },
    {
      path: "ppt/_rels/presentation.xml.rels",
      content: relationshipsXml([
        { id: "rId1", type: `${R}/slideMaster`, target: "slideMasters/slideMaster1.xml" },
        { id: "rId2", type: `${R}/slide`, target: "slides/slide1.xml" },
        { id: "rId3", type: `${R}/slide`, target: "slides/slide2.xml" },
      ]),
    },
    { path: "ppt/slideMasters/slideMaster1.xml", content: MASTER_XML },
    {
      path: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      content: relationshipsXml([
        { id: "rId1", type: `${R}/slideLayout`, target: "../slideLayouts/slideLayout1.xml" },
        { id: "rId2", type: `${R}/theme`, target: "../theme/theme1.xml" },
      ]),
    },
    { path: "ppt/slideLayouts/slideLayout1.xml", content: LAYOUT_XML },
    {
      path: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      content: relationshipsXml([
        { id: "rId1", type: `${R}/slideMaster`, target: "../slideMasters/slideMaster1.xml" },
      ]),
    },
    { path: "ppt/theme/theme1.xml", content: OFFICE_THEME_XML },
    {
      path: "ppt/slides/slide1.xml",
      content: slideRoot(options?.slideOneBody ?? SLIDE_ONE_BODY),
    },
    {
      path: "ppt/slides/_rels/slide1.xml.rels",
      content: relationshipsXml([
        { id: "rIdLayout", type: `${R}/slideLayout`, target: "../slideLayouts/slideLayout1.xml" },
        { id: "rIdImg", type: `${R}/image`, target: "../media/image1.png" },
        { id: "rIdChart", type: `${R}/chart`, target: "../charts/chart1.xml" },
        { id: "rIdDm", type: `${R}/diagramData`, target: "../diagrams/data1.xml" },
        { id: "rIdLo", type: `${R}/diagramLayout`, target: "../diagrams/layout1.xml" },
        { id: "rIdQs", type: `${R}/diagramQuickStyle`, target: "../diagrams/quickStyle1.xml" },
        { id: "rIdCs", type: `${R}/diagramColors`, target: "../diagrams/colors1.xml" },
        {
          id: "rIdVideo",
          type: `${R}/video`,
          target: "https://example.com/clip.mp4",
          targetMode: "External",
        },
      ]),
    },
    { path: "ppt/slides/slide2.xml", content: slideRoot(SLIDE_TWO_BODY) },
    {
      path: "ppt/slides/_rels/slide2.xml.rels",
      content: relationshipsXml([
        { id: "rIdLayout", type: `${R}/slideLayout`, target: "../slideLayouts/slideLayout1.xml" },
      ]),
    },
    { path: "ppt/media/image1.png", content: Buffer.from(PNG_1X1_BASE64, "base64") },
    { path: "ppt/charts/chart1.xml", content: "<c:chartSpace/>" },
    ...(options?.extraSlides ?? []),
  ]);
}

describe("PPTX fixed slide geometry", () => {
  it("reads the declared slide size in points", async () => {
    const preview = parseOfficePreviewBuffer(await buildDeckFixture(), "pptx");
    expectValidPreview(preview);
    expect(preview?.slideSize).toEqual({ widthPt: 960, heightPt: 540 });
  });

  it("places inherited placeholders from the slide layout frames", async () => {
    const preview = parseOfficePreviewBuffer(await buildDeckFixture(), "pptx");
    const title = preview?.slides?.[0]?.shapes?.[0];
    if (!title) {
      throw new Error("expected a placed title shape");
    }
    expect(title).toMatchObject({
      kind: "shape",
      xPt: 66,
      yPt: 28.8,
      widthPt: 828,
      heightPt: 104.4,
      verticalAnchor: "middle",
    });
    // The master titleStyle supplies the 44pt bold theme-colored run.
    expect(title.paragraphs?.[0]?.alignment).toBe("center");
    expect(title.paragraphs?.[0]?.runs?.[0]).toEqual({
      text: "Fixed slide title",
      bold: true,
      fontSizePt: 44,
      color: "#44546a",
    });
  });

  it("keeps absolute shape boxes, fills, and lines", async () => {
    const preview = parseOfficePreviewBuffer(await buildDeckFixture(), "pptx");
    const shapes = preview?.slides?.[0]?.shapes ?? [];
    const text = shapes[1]!;
    expect(text).toMatchObject({
      kind: "shape",
      xPt: 100,
      yPt: 200,
      widthPt: 300,
      heightPt: 100,
      preset: "rect",
      textScalePct: 75,
      verticalAnchor: "top",
    });
    expect(text.fill).toBeUndefined();
    expect(text.paragraphs?.[0]).toMatchObject({
      text: "Revenue up",
      alignment: "left",
      listMarker: "•",
    });
    expect(text.paragraphs?.[0]?.runs?.[0]).toMatchObject({
      text: "Revenue up",
      bold: true,
      fontSizePt: 24,
      color: "#ff0000",
      // Theme font references resolve to the theme's declared face name.
      fontName: "Aptos Display",
    });
    // A centered paragraph drops the inherited bullet and keeps declared spacing.
    expect(text.paragraphs?.[1]).toMatchObject({
      text: "Second line",
      alignment: "center",
      spaceBeforePt: 6,
    });
    expect(text.paragraphs?.[1]?.listMarker).toBeUndefined();
    expect(text.paragraphs?.[1]?.runs?.[0]).toMatchObject({
      fontSizePt: 16,
      color: "#ed7d31",
    });

    const panel = shapes[2]!;
    expect(panel).toMatchObject({
      kind: "shape",
      xPt: 50,
      yPt: 300,
      widthPt: 200,
      heightPt: 50,
      preset: "roundRect",
      fill: "#4472c4",
      lineColor: "#1f3864",
      lineWidthPt: 2,
    });
    expect(panel.paragraphs).toBeUndefined();
  });

  it("maps group child coordinates into the group box", async () => {
    const preview = parseOfficePreviewBuffer(await buildDeckFixture(), "pptx");
    const grouped = (preview?.slides?.[0]?.shapes ?? []).find(
      (entry) => entry.preset === "ellipse",
    );
    // A 20pt child origin inside a 100pt child space scaled into a 200pt group box.
    expect(grouped).toMatchObject({
      xPt: 540,
      yPt: 240,
      widthPt: 80,
      heightPt: 80,
      fill: "#70ad47",
    });
  });

  it("reads table grids, cells, spans, and shading", async () => {
    const preview = parseOfficePreviewBuffer(await buildDeckFixture(), "pptx");
    const table = (preview?.slides?.[0]?.shapes ?? []).find((entry) => entry.kind === "table")!;
    expect(table).toMatchObject({ xPt: 100, yPt: 400, widthPt: 400, heightPt: 100 });
    expect(table.table?.columnWidthsPt).toEqual([200, 200]);
    expect(table.table?.rows).toHaveLength(2);
    expect(table.table?.rows[0]?.cells[0]).toMatchObject({
      shading: "#d9e2f3",
      border: { top: { style: "thin", color: "#000000" } },
    });
    expect(table.table?.rows[0]?.cells[0]?.paragraphs[0]?.runs?.[0]).toMatchObject({
      text: "Region",
      bold: true,
      fontSizePt: 14,
    });
    expect(table.table?.rows[1]?.cells[0]).toMatchObject({ columnSpan: 2 });
  });

  it("inlines slide media and keeps its declared box", async () => {
    const preview = parseOfficePreviewBuffer(await buildDeckFixture(), "pptx");
    const image = (preview?.slides?.[0]?.shapes ?? []).find((entry) => entry.kind === "image")!;
    expect(image).toMatchObject({
      media: 0,
      alt: "Synthetic logo",
      xPt: 700,
      yPt: 36,
      widthPt: 100,
      heightPt: 100,
    });
    expect(preview?.media?.[0]?.dataUrl).toBe(`data:image/png;base64,${PNG_1X1_BASE64}`);
  });

  it("reports charts, diagrams, external media, and unplaced shapes as omitted", async () => {
    const preview = parseOfficePreviewBuffer(await buildDeckFixture(), "pptx");
    expectValidPreview(preview);
    const omitted = Object.fromEntries(
      (preview?.omitted ?? []).map((entry) => [entry.feature, entry.count]),
    );
    expect(omitted.charts).toBe(1);
    expect(omitted.diagrams).toBe(1);
    expect(omitted.media).toBe(1);
    expect(omitted.floatingObjects).toBe(1);
    // Every placeable shape is on the slide: title, notes, panel, picture, table, group child.
    expect(preview?.slides?.[0]?.shapes).toHaveLength(6);
  });

  it("keeps the plain-text outline for readers that ignore geometry", async () => {
    const preview = parseOfficePreviewBuffer(await buildDeckFixture(), "pptx");
    expect(preview?.slides?.[0]).toMatchObject({
      index: 1,
      title: "Fixed slide title",
      lines: ["Revenue up", "Second line", "Lost position"],
    });
    expect(preview?.slides?.[1]).toMatchObject({ index: 2, lines: ["Second slide body"] });
  });

  it("reads the slide background and resolves theme text colors", async () => {
    const preview = parseOfficePreviewBuffer(await buildDeckFixture(), "pptx");
    const slide = preview?.slides?.[1];
    if (!slide) {
      throw new Error("expected the second slide");
    }
    expect(slide.background).toBe("#1f3864");
    expect(slide.shapes?.[0]?.paragraphs?.[0]).toMatchObject({ alignment: "center" });
    // `bg1` maps through the master clrMap to the light theme slot.
    expect(slide.shapes?.[0]?.paragraphs?.[0]?.runs?.[0]).toMatchObject({
      text: "Second slide body",
      fontSizePt: 32,
      color: "#ffffff",
    });
  });

  it("defaults the canvas when the package declares no slide size", async () => {
    const preview = parseOfficePreviewBuffer(await buildDeckFixture({ slideSize: null }), "pptx");
    expectValidPreview(preview);
    expect(preview?.slideSize).toEqual({ widthPt: 720, heightPt: 540 });
  });

  it("keeps the outline path for a deck whose shapes carry no geometry", async () => {
    const preview = parseOfficePreviewBuffer(await buildPptxFixture(), "pptx");
    expectValidPreview(preview);
    expect(preview?.slides?.[0]?.shapes).toBeUndefined();
    expect(preview?.omitted?.map((entry) => entry.feature)).toContain("floatingObjects");
  });

  it("bounds the shapes per slide and reports the cut", async () => {
    const shapes = Array.from(
      { length: 205 },
      (_, index) =>
        `<p:sp><p:nvSpPr><p:cNvPr id="${index + 2}" name="S${index}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="127000" cy="127000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp>`,
    ).join("");
    const preview = parseOfficePreviewBuffer(
      await buildDeckFixture({ slideOneBody: spTree(shapes) }),
      "pptx",
    );
    expectValidPreview(preview);
    expect(preview?.slides?.[0]?.shapes).toHaveLength(200);
    expect(preview?.truncated).toBe(true);
  });
});
