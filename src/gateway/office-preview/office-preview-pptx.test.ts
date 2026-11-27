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

function slideRoot(body: string, attributes = ""): string {
  return `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" xmlns:dgm="${DGM}" xmlns:c="${CHART}"${attributes}><p:cSld>${body}</p:cSld></p:sld>`;
}

function spTree(body: string): string {
  return `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${body}</p:spTree>`;
}

function shape(params: {
  id: number;
  name?: string;
  placeholder?: string | null;
  idx?: number;
  xfrm?: string;
  fill?: string;
  preset?: string;
  bodyAttributes?: string;
  bodyInner?: string;
  listStyle?: string;
  paragraphs?: string;
}): string {
  const placeholder =
    params.placeholder === undefined
      ? ""
      : `<p:ph${params.placeholder === null ? "" : ` type="${params.placeholder}"`}${
          params.idx === undefined ? "" : ` idx="${params.idx}"`
        }/>`;
  const geometry = params.xfrm ?? "";
  const preset =
    params.preset === undefined
      ? ""
      : `<a:prstGeom prst="${params.preset}"><a:avLst/></a:prstGeom>`;
  const body = params.paragraphs
    ? `<p:txBody><a:bodyPr${params.bodyAttributes ? ` ${params.bodyAttributes}` : ""}>${
        params.bodyInner ?? ""
      }</a:bodyPr><a:lstStyle>${params.listStyle ?? ""}</a:lstStyle>${params.paragraphs}</p:txBody>`
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

function masterXml(options?: { background?: string; titleColor?: string; tree?: string }): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld>${options?.background ?? ""}${spTree(options?.tree ?? placeholderTree())}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" hlink="hlink" folHlink="folHlink"/><p:txStyles>
<p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="${options?.titleColor ?? "tx2"}"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle>
<p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="&#8226;"/><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>
<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="75000"/></a:schemeClr></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:otherStyle>
</p:txStyles></p:sldMaster>`;
}

function layoutXml(background = "", tree = placeholderTree()): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld>${background}${spTree(tree)}</p:cSld></p:sldLayout>`;
}

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

const TITLE_ONLY = spTree(
  shape({
    id: 2,
    name: "Title 1",
    placeholder: "ctrTitle",
    paragraphs: `<a:p>${run("Inherited background title")}</a:p>`,
  }),
);

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
  masterXml?: string;
  layoutXml?: string;
  layoutRelationships?: readonly OfficeFixtureRelationship[];
  slideOneAttributes?: string;
  extraSlides?: readonly OfficeFixtureFile[];
  presentationParts?: readonly OfficeFixtureFile[];
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
    { path: "ppt/slideMasters/slideMaster1.xml", content: options?.masterXml ?? masterXml() },
    {
      path: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      content: relationshipsXml([
        { id: "rId1", type: `${R}/slideLayout`, target: "../slideLayouts/slideLayout1.xml" },
        { id: "rId2", type: `${R}/theme`, target: "../theme/theme1.xml" },
      ]),
    },
    { path: "ppt/slideLayouts/slideLayout1.xml", content: options?.layoutXml ?? layoutXml() },
    {
      path: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      content: relationshipsXml([
        { id: "rId1", type: `${R}/slideMaster`, target: "../slideMasters/slideMaster1.xml" },
        ...(options?.layoutRelationships ?? []),
      ]),
    },
    { path: "ppt/theme/theme1.xml", content: OFFICE_THEME_XML },
    {
      path: "ppt/slides/slide1.xml",
      content: slideRoot(
        options?.slideOneBody ?? SLIDE_ONE_BODY,
        options?.slideOneAttributes ?? "",
      ),
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

  it("resolves gallery p:style fill, line, and font references", async () => {
    const body = spTree(
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Gallery"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="3"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="2"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Gallery shape</a:t></a:r></a:p></p:txBody></p:sp>` +
        `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Outline"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="1270000" y="3810000"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:style><a:lnRef idx="2"><a:schemeClr val="accent2"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef><a:fontRef idx="none"/></p:style><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Outline only</a:t></a:r></a:p></p:txBody></p:sp>`,
    );
    const preview = parseOfficePreviewBuffer(
      await buildDeckFixture({ slideOneBody: body }),
      "pptx",
    );
    expectValidPreview(preview);
    const gallery = preview?.slides?.[0]?.shapes?.[0];
    // PowerPoint's shape-gallery styling lives only in p:style references.
    expect(gallery).toMatchObject({
      kind: "shape",
      preset: "rect",
      fill: "#4472c4",
      lineColor: "#4472c4",
      lineWidthPt: 0.5,
    });
    expect(gallery?.paragraphs?.[0]?.runs?.[0]).toEqual({
      text: "Gallery shape",
      fontSizePt: 18,
      color: "#ffffff",
      fontName: "Aptos",
    });
    // `idx="0"` means no fill, and the theme line style carries the width.
    const outline = preview?.slides?.[0]?.shapes?.[1];
    expect(outline).toMatchObject({
      kind: "shape",
      lineColor: "#ed7d31",
      lineWidthPt: 1,
    });
    expect(outline?.fill).toBeUndefined();
    expect(outline?.paragraphs?.[0]?.runs?.[0]).toMatchObject({
      text: "Outline only",
      fontSizePt: 18,
      // fontRef idx="none" leaves the master default (tx1, the real default theme).
      color: "#000000",
      fontName: "Aptos",
    });
  });

  it("keeps the shape fontRef above the default theme text chain", async () => {
    // Real Office masters style `otherStyle` with tx1 + `+mn-lt`; a bare
    // gallery-shape run still resolves to the fontRef color (lt1 = white).
    const body = spTree(
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Plain"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Plain default</a:t></a:r></a:p></p:txBody></p:sp>` +
        `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Gallery"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="2540000"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="3"><a:schemeClr val="accent1"/></a:fillRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Gallery default</a:t></a:r></a:p></p:txBody></p:sp>`,
    );
    const preview = parseOfficePreviewBuffer(
      await buildDeckFixture({ slideOneBody: body }),
      "pptx",
    );
    expectValidPreview(preview);
    // A shape without `p:style` keeps the master default chain: tx1 + Aptos.
    expect(preview?.slides?.[0]?.shapes?.[0]?.paragraphs?.[0]?.runs?.[0]).toMatchObject({
      text: "Plain default",
      color: "#000000",
      fontName: "Aptos",
      fontSizePt: 18,
    });
    // The fontRef tier wins over that same default chain.
    expect(preview?.slides?.[0]?.shapes?.[1]?.paragraphs?.[0]?.runs?.[0]).toMatchObject({
      text: "Gallery default",
      color: "#ffffff",
      fontName: "Aptos",
      fontSizePt: 18,
    });
  });

  it("keeps gradient-filled custom geometry and takes its first stop", async () => {
    const body = spTree(
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Gradient"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:custGeom><a:avLst/><a:pathLst/></a:custGeom><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst></a:gradFill></p:spPr></p:sp>`,
    );
    const preview = parseOfficePreviewBuffer(
      await buildDeckFixture({ slideOneBody: body }),
      "pptx",
    );
    expectValidPreview(preview);
    // A gradient must never make a placed shape disappear without a notice.
    expect(preview?.slides?.[0]?.shapes).toHaveLength(1);
    expect(preview?.slides?.[0]?.shapes?.[0]).toMatchObject({ kind: "shape", fill: "#ff0000" });
    expect(preview?.slides?.[0]?.shapes?.[0]?.preset).toBeUndefined();
  });

  it("composes nested group scales in slide space", async () => {
    const body = spTree(
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="Outer"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="2540000"/><a:chOff x="0" y="0"/><a:chExt cx="1270000" cy="1270000"/></a:xfrm></p:grpSpPr><p:grpSp><p:nvGrpSpPr><p:cNvPr id="3" name="Inner"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="127000" y="127000"/><a:ext cx="635000" cy="635000"/><a:chOff x="0" y="0"/><a:chExt cx="635000" cy="635000"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="4" name="Leaf"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="317500" y="317500"/><a:ext cx="127000" cy="127000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp></p:grpSp></p:grpSp>`,
    );
    const preview = parseOfficePreviewBuffer(
      await buildDeckFixture({ slideOneBody: body }),
      "pptx",
    );
    expectValidPreview(preview);
    // Outer 2x at (100,100), inner 1x at (10,10), leaf at (25,25,10,10):
    // 100 + 10*2 + 25*2 = 170, size 10*2 = 20.
    expect(preview?.slides?.[0]?.shapes?.[0]).toMatchObject({
      xPt: 170,
      yPt: 170,
      widthPt: 20,
      heightPt: 20,
    });
  });

  it("clamps extreme authored values to the closed protocol bounds", async () => {
    const longFace = "X".repeat(80);
    const text = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Extreme"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="2540000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr marL="50800000" indent="-50800000"><a:buAutoNum type="arabicPeriod"/></a:pPr><a:r><a:rPr sz="50"><a:latin typeface="${longFace}"/></a:rPr><a:t>Extreme</a:t></a:r></a:p><a:p><a:pPr><a:lnSpc><a:spcPct val="400000"/></a:lnSpc></a:pPr><a:r><a:rPr sz="40000"/><a:t>Huge</a:t></a:r></a:p></p:txBody></p:sp>`;
    const columns = Array.from({ length: 70 }, () => '<a:gridCol w="127000"/>').join("");
    const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Wide"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="8890000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid>${columns}</a:tblGrid><a:tr h="381000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Wide</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const preview = parseOfficePreviewBuffer(
      await buildDeckFixture({ slideOneBody: spTree(text + table) }),
      "pptx",
    );
    expect(Value.Check(SessionFileOfficePreviewSchema, preview)).toBe(true);
    const extreme = preview?.slides?.[0]?.shapes?.[0];
    expect(extreme?.paragraphs?.[0]).toMatchObject({
      indentLeftPt: 2_000,
      indentFirstLinePt: -2_000,
    });
    expect(extreme?.paragraphs?.[0]?.runs?.[0]).toMatchObject({ fontSizePt: 1 });
    expect(extreme?.paragraphs?.[0]?.runs?.[0]?.fontName).toHaveLength(64);
    expect(extreme?.paragraphs?.[1]).toMatchObject({ lineSpacingPt: 1_000 });
    const wide = (preview?.slides?.[0]?.shapes ?? []).find((entry) => entry.kind === "table");
    expect(wide?.table?.columnWidthsPt).toHaveLength(64);
  });

  it("inherits slide backgrounds from the layout and master", async () => {
    const darkMaster = {
      background:
        '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="dk2"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>',
      titleColor: "lt1",
    };
    // A dark master keeps its light title readable on the inherited paper.
    const masterOnly = parseOfficePreviewBuffer(
      await buildDeckFixture({
        masterXml: masterXml(darkMaster),
        slideOneBody: TITLE_ONLY,
      }),
      "pptx",
    );
    expectValidPreview(masterOnly);
    expect(masterOnly?.slides?.[0]?.background).toBe("#44546a");
    expect(masterOnly?.slides?.[0]?.shapes?.[0]?.paragraphs?.[0]?.runs?.[0]?.color).toBe("#ffffff");

    // The layout background wins over the master, and gradients take the first stop.
    const layoutGradient = parseOfficePreviewBuffer(
      await buildDeckFixture({
        masterXml: masterXml(darkMaster),
        layoutXml: layoutXml(
          '<p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="112233"/></a:gs><a:gs pos="100000"><a:srgbClr val="445566"/></a:gs></a:gsLst></a:gradFill></p:bgPr></p:bg>',
        ),
        slideOneBody: TITLE_ONLY,
      }),
      "pptx",
    );
    expectValidPreview(layoutGradient);
    expect(layoutGradient?.slides?.[0]?.background).toBe("#112233");

    // A slide background wins over both parents, gradients included.
    const slideGradient = parseOfficePreviewBuffer(
      await buildDeckFixture({
        masterXml: masterXml(darkMaster),
        slideOneBody: `<p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="ABCDEF"/></a:gs><a:gs pos="100000"><a:srgbClr val="111111"/></a:gs></a:gsLst></a:gradFill></p:bgPr></p:bg>${TITLE_ONLY}`,
      }),
      "pptx",
    );
    expectValidPreview(slideGradient);
    expect(slideGradient?.slides?.[0]?.background).toBe("#abcdef");
  });

  it("reports an undrawable background instead of hiding it", async () => {
    const preview = parseOfficePreviewBuffer(
      await buildDeckFixture({
        masterXml: masterXml({
          background:
            '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="dk2"/></a:solidFill></p:bgPr></p:bg>',
        }),
        slideOneBody: `<p:bg><p:bgPr><a:pattFill prst="pct5"><a:fgClr><a:srgbClr val="FF0000"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill></p:bgPr></p:bg>${TITLE_ONLY}`,
      }),
      "pptx",
    );
    expectValidPreview(preview);
    // The undrawable slide background falls back to the inherited master color.
    expect(preview?.slides?.[0]?.background).toBe("#44546a");
    expect(preview?.omitted?.find((entry) => entry.feature === "drawings")?.count).toBe(1);

    // A transparent slide background simply shows the inherited one.
    const transparent = parseOfficePreviewBuffer(
      await buildDeckFixture({
        masterXml: masterXml({
          background:
            '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="dk2"/></a:solidFill></p:bgPr></p:bg>',
        }),
        slideOneBody: `<p:bg><p:bgPr><a:noFill/></p:bgPr></p:bg>${TITLE_ONLY}`,
      }),
      "pptx",
    );
    expectValidPreview(transparent);
    expect(transparent?.slides?.[0]?.background).toBe("#44546a");
    expect(transparent?.omitted?.some((entry) => entry.feature === "drawings") ?? false).toBe(
      false,
    );
  });

  it("renders every connector preset as a line, never a box", async () => {
    const connector = (id: number, name: string, preset: string, hidden = false): string =>
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:prstGeom prst="${preset}"><a:avLst/></a:prstGeom>${
        hidden
          ? "<a:ln><a:noFill/></a:ln>"
          : '<a:ln w="12700"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln>'
      }</p:spPr></p:cxnSp>`;
    const preview = parseOfficePreviewBuffer(
      await buildDeckFixture({
        slideOneBody: spTree(
          connector(2, "Straight", "straightConnector1") +
            connector(3, "Elbow", "bentConnector3") +
            connector(4, "Curved", "curvedConnector3") +
            connector(5, "Hidden", "straightConnector1", true),
        ),
      }),
      "pptx",
    );
    expectValidPreview(preview);
    const shapes = preview?.slides?.[0]?.shapes ?? [];
    // The `a:ln noFill` connector paints nothing, so it is not placed.
    expect(shapes).toHaveLength(3);
    for (const connectorShape of shapes) {
      expect(connectorShape).toMatchObject({
        kind: "shape",
        preset: "line",
        lineColor: "#4472c4",
        lineWidthPt: 1,
      });
    }
    // Elbow and curved routing become straight segments; straight is exact.
    expect(preview?.omitted?.find((entry) => entry.feature === "drawings")?.count).toBe(2);
  });

  it("keeps the theme line color for a width-only a:ln override", async () => {
    const body = spTree(
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="WidthOnly"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="38100"/></p:spPr><p:style><a:lnRef idx="2"><a:schemeClr val="accent2"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef></p:style></p:sp>`,
    );
    const preview = parseOfficePreviewBuffer(
      await buildDeckFixture({ slideOneBody: body }),
      "pptx",
    );
    expectValidPreview(preview);
    expect(preview?.slides?.[0]?.shapes?.[0]).toMatchObject({
      fill: "#4472c4",
      lineColor: "#ed7d31",
      lineWidthPt: 3,
    });
  });

  it("counts an undrawable gradient once per shape", async () => {
    const body = spTree(
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Unresolved"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:custGeom><a:avLst/><a:pathLst/></a:custGeom><a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="accent9"/></a:gs><a:gs pos="100000"><a:schemeClr val="accent9"/></a:gs></a:gsLst></a:gradFill></p:spPr></p:sp>`,
    );
    const preview = parseOfficePreviewBuffer(
      await buildDeckFixture({ slideOneBody: body }),
      "pptx",
    );
    expectValidPreview(preview);
    expect(preview?.slides?.[0]?.shapes).toBeUndefined();
    expect(preview?.omitted?.find((entry) => entry.feature === "drawings")?.count).toBe(1);
  });

  it("retains flip facts while text stays readable in the renderer", async () => {
    const body = spTree(
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Flipped"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm flipH="1"><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1800"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>Flipped text</a:t></a:r></a:p></p:txBody></p:sp>`,
    );
    const preview = parseOfficePreviewBuffer(
      await buildDeckFixture({ slideOneBody: body }),
      "pptx",
    );
    expectValidPreview(preview);
    expect(preview?.slides?.[0]?.shapes?.[0]).toMatchObject({
      kind: "shape",
      flipHorizontal: true,
    });
    expect(preview?.slides?.[0]?.shapes?.[0]?.paragraphs?.[0]?.text).toBe("Flipped text");
  });

  it("resolves typeless placeholders through layout and list styles", async () => {
    // PowerPoint writes content placeholders with the type only on the layout;
    // the layout's list style carries the 32pt body size and the bullet.
    const layoutTree = `${shape({
      id: 2,
      name: "Title",
      placeholder: "title",
      xfrm: LAYOUT_TITLE_XFRM,
      paragraphs: "<a:p/>",
    })}
${shape({
  id: 3,
  name: "Content",
  placeholder: null,
  idx: 1,
  xfrm: LAYOUT_BODY_XFRM,
  listStyle: '<a:lvl1pPr><a:buChar char="&#8226;"/><a:defRPr sz="3200"/></a:lvl1pPr>',
  paragraphs: "<a:p/>",
})}`;
    const slideBody = spTree(
      shape({
        id: 2,
        name: "Body",
        placeholder: null,
        idx: 1,
        paragraphs: `<a:p>${run("Body paragraph")}</a:p>`,
      }) +
        shape({
          id: 3,
          name: "OwnStyle",
          xfrm: `<a:xfrm><a:off x="1270000" y="5080000"/><a:ext cx="5080000" cy="1270000"/></a:xfrm>`,
          preset: "rect",
          listStyle: '<a:lvl1pPr><a:defRPr sz="2800" b="1"/></a:lvl1pPr>',
          paragraphs: `<a:p>${run("Own style")}</a:p>`,
        }),
    );
    const preview = parseOfficePreviewBuffer(
      await buildDeckFixture({ layoutXml: layoutXml("", layoutTree), slideOneBody: slideBody }),
      "pptx",
    );
    expectValidPreview(preview);
    const body = preview?.slides?.[0]?.shapes?.[0];
    expect(body).toMatchObject({ xPt: 66, yPt: 143.8, widthPt: 828, heightPt: 342.6 });
    expect(body?.paragraphs?.[0]).toMatchObject({ text: "Body paragraph", listMarker: "•" });
    expect(body?.paragraphs?.[0]?.runs?.[0]).toMatchObject({ fontSizePt: 32 });
    // The shape's own list style outranks the master's other style.
    expect(preview?.slides?.[0]?.shapes?.[1]?.paragraphs?.[0]?.runs?.[0]).toMatchObject({
      text: "Own style",
      fontSizePt: 28,
      bold: true,
    });
  });

  it("composes master and layout decorations in PowerPoint z-order", async () => {
    const bar = (y: number, height: number, color: string): string =>
      shape({
        id: 20,
        name: "Bar",
        xfrm: `<a:xfrm><a:off x="0" y="${y}"/><a:ext cx="12192000" cy="${height}"/></a:xfrm>`,
        preset: "rect",
        fill: `<a:solidFill><a:schemeClr val="${color}"/></a:solidFill>`,
      });
    const logo = `<p:pic><p:nvPicPr><p:cNvPr id="21" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="10160000" y="254000"/><a:ext cx="1016000" cy="1016000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
    const chart = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="22" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="${CHART}"><c:chart r:id="rIdChart"/></a:graphicData></a:graphic></p:graphicFrame>`;
    const preview = parseOfficePreviewBuffer(
      await buildDeckFixture({
        masterXml: masterXml({
          tree: `${placeholderTree()}
${bar(0, 254000, "dk2")}`,
        }),
        layoutXml: layoutXml(
          "",
          `${placeholderTree()}
${bar(6350000, 508000, "accent1")}
${logo}
${chart}`,
        ),
        layoutRelationships: [{ id: "rIdLogo", type: `${R}/image`, target: "../media/image1.png" }],
        slideOneBody: TITLE_ONLY,
      }),
      "pptx",
    );
    expectValidPreview(preview);
    const shapes = preview?.slides?.[0]?.shapes ?? [];
    // Layout bar overrides the master bar with the same name, keeping its slot.
    expect(shapes[0]).toMatchObject({ kind: "shape", yPt: 500, heightPt: 40, fill: "#4472c4" });
    expect(shapes.some((placed) => placed.yPt === 0 && placed.heightPt === 20)).toBe(false);
    // The layout logo is an inlined picture beneath the slide's own content.
    expect(shapes[1]).toMatchObject({ kind: "image", media: 0, xPt: 800, yPt: 20 });
    expect(shapes[2]).toMatchObject({ xPt: 66, yPt: 28.8 });
    expect(shapes).toHaveLength(3);
    // An unsupported template graphic is reported, never silently dropped.
    expect(preview?.omitted?.find((entry) => entry.feature === "charts")?.count).toBe(1);

    // `showMasterSp="0"` suppresses master decorations but keeps layout ones.
    const withoutMaster = parseOfficePreviewBuffer(
      await buildDeckFixture({
        masterXml: masterXml({
          tree: `${placeholderTree()}
${bar(0, 254000, "dk2")}`,
        }),
        slideOneAttributes: ' showMasterSp="0"',
        slideOneBody: TITLE_ONLY,
      }),
      "pptx",
    );
    expectValidPreview(withoutMaster);
    expect(withoutMaster?.slides?.[0]?.shapes).toHaveLength(1);
  });

  it("scales derived line spacing with the autofit factor", async () => {
    const body = spTree(
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Autofit"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr><a:normAutofit fontScale="75000"/></a:bodyPr><a:lstStyle/><a:p><a:pPr><a:lnSpc><a:spcPts val="1000"/></a:lnSpc></a:pPr><a:r><a:rPr sz="2000"/><a:t>Autofit</a:t></a:r></a:p></p:txBody></p:sp>`,
    );
    const preview = parseOfficePreviewBuffer(
      await buildDeckFixture({ slideOneBody: body }),
      "pptx",
    );
    expectValidPreview(preview);
    const autofit = preview?.slides?.[0]?.shapes?.[0];
    expect(autofit?.textScalePct).toBe(75);
    // Authored 10pt spacing follows the 75% auto-shrink; run sizes stay authored.
    expect(autofit?.paragraphs?.[0]?.lineSpacingPt).toBe(7.5);
    expect(autofit?.paragraphs?.[0]?.runs?.[0]).toMatchObject({ fontSizePt: 20 });
  });

  it("retains connector rotation and flip facts for the renderer", async () => {
    const connector = (id: number, attributes: string): string =>
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="C${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm${attributes}><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="0"/></a:xfrm><a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom><a:ln w="12700"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln></p:spPr></p:cxnSp>`;
    const preview = parseOfficePreviewBuffer(
      await buildDeckFixture({
        slideOneBody: spTree(`${connector(2, ' rot="5400000"')}${connector(3, ' flipH="1"')}`),
      }),
      "pptx",
    );
    expectValidPreview(preview);
    const shapes = preview?.slides?.[0]?.shapes ?? [];
    expect(shapes[0]).toMatchObject({ preset: "line", rotationDeg: 90 });
    expect(shapes[1]).toMatchObject({ preset: "line", flipHorizontal: true });
  });
});
