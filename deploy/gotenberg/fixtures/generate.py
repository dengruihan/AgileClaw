"""Generate deterministic synthetic Office fixtures for Gotenberg proof."""
import pathlib
import zipfile

OUT = pathlib.Path(__file__).resolve().parent
OUT.mkdir(exist_ok=True)
DATE = (2026, 1, 1, 0, 0, 0)

REL = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"

def write(name, parts):
    path = OUT / name
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for part, body in parts:
            info = zipfile.ZipInfo(part, DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, body)
    print(path.name, path.stat().st_size)

def content_types(overrides, defaults=()):
    d = "".join(f'<Default Extension="{e}" ContentType="{t}"/>' for e, t in defaults)
    o = "".join(f'<Override PartName="{p}" ContentType="{t}"/>' for p, t in overrides)
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">{d}<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>{o}</Types>'

def rels(entries):
    body = "".join(f'<Relationship Id="{i}" Type="{t}" Target="{g}"/>' for i, t, g in entries)
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="{REL}">{body}</Relationships>'

# --- DOCX: US Letter (8.5 x 11 in => 12240 x 15840 twips) ---
write("synthetic-letter.docx", [
    ("[Content_Types].xml", content_types([
        ("/word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"),
    ])),
    ("_rels/.rels", rels([("rId1", f"{OFFICE_REL}/officeDocument", "word/document.xml")])),
    ("word/document.xml", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}"><w:body>'
        '<w:p><w:r><w:t>OpenClaw synthetic US Letter page</w:t></w:r></w:p>'
        '<w:p><w:r><w:t>Gotenberg conversion fixture, no real data.</w:t></w:r></w:p>'
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
        '</w:body></w:document>'),
])

# --- XLSX: print area A1:C10 of 40 rows, A4 landscape ---
rows = []
for r in range(1, 41):
    cells = "".join(
        f'<c r="{col}{r}" t="inlineStr"><is><t>{col}{r}</t></is></c>' for col in "ABC"
    )
    rows.append(f'<row r="{r}">{cells}</row>')
sheet = (
    f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="{S}">'
    '<dimension ref="A1:C40"/>'
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
    '<sheetFormatPr defaultRowHeight="15"/>'
    '<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="14" customWidth="1"/><col min="3" max="3" width="14" customWidth="1"/></cols>'
    f'<sheetData>{"".join(rows)}</sheetData>'
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
    '<pageSetup paperSize="9" orientation="landscape" scale="100"/>'
    '</worksheet>'
)
styles = (
    f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="{S}">'
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
    '<borders count="1"><border/></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
    '</styleSheet>'
)
write("synthetic-print-area.xlsx", [
    ("[Content_Types].xml", content_types([
        ("/xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"),
        ("/xl/worksheets/sheet1.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"),
        ("/xl/styles.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"),
    ])),
    ("_rels/.rels", rels([("rId1", f"{OFFICE_REL}/officeDocument", "xl/workbook.xml")])),
    ("xl/workbook.xml", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="{S}" xmlns:r="{OFFICE_REL}">'
        '<sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets>'
        f'<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Report!$A$1:$C$10</definedName></definedNames>'
        '</workbook>'),
    ("xl/_rels/workbook.xml.rels", rels([
        ("rId1", f"{OFFICE_REL}/worksheet", "worksheets/sheet1.xml"),
        ("rId2", f"{OFFICE_REL}/styles", "styles.xml"),
    ])),
    ("xl/worksheets/sheet1.xml", sheet),
    ("xl/styles.xml", styles),
])

# --- PPTX: 16:9 (12192000 x 6858000 EMU => 960 x 540 pt) ---
theme = (
    f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="{A}" name="Office">'
    '<a:themeElements>'
    '<a:clrScheme name="Office">'
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
    '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>'
    '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>'
    '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>'
    '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>'
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
    '</a:clrScheme>'
    '<a:fontScheme name="Office">'
    '<a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont>'
    '<a:minorFont><a:latin typeface="Aptos"/></a:minorFont>'
    '</a:fontScheme>'
    '<a:fmtScheme name="Office">'
    '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
    '<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
    '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>'
    '</a:fmtScheme>'
    '</a:themeElements>'
    '</a:theme>'
)
tree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
slide_master = (
    f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="{A}" xmlns:r="{OFFICE_REL}" xmlns:p="{P}">'
    f'<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>{tree}</p:spTree></p:cSld>'
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
    '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>'
    '</p:sldMaster>'
)
slide_layout = (
    f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="{A}" xmlns:r="{OFFICE_REL}" xmlns:p="{P}" type="blank" preserve="1">'
    f'<p:cSld name="Blank"><p:spTree>{tree}</p:spTree></p:cSld>'
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
    '</p:sldLayout>'
)
def shape(shape_id, name, title, lines, x, y, cx, cy, size):
    paras = "".join(f'<a:p><a:r><a:rPr lang="en-US" sz="{size}"/><a:t>{text}</a:t></a:r></a:p>' for text in [title, *lines])
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{shape_id}" name="{name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm></p:spPr>'
        f'<p:txBody><a:bodyPr/><a:lstStyle/>{paras}</p:txBody></p:sp>'
    )
slide1 = (
    f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="{A}" xmlns:r="{OFFICE_REL}" xmlns:p="{P}">'
    f'<p:cSld><p:spTree>{tree}'
    + shape(2, "Title", "Quarterly review", ["Synthetic 16:9 slide"], 838200, 365125, 10515600, 1325563, 3200)
    + shape(3, "Body", "Previews render on the report canvas.", ["No real data in this fixture."], 838200, 1825625, 10515600, 4351338, 1800)
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
)
write("synthetic-wide-slide.pptx", [
    ("[Content_Types].xml", content_types([
        ("/ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"),
        ("/ppt/slideMasters/slideMaster1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"),
        ("/ppt/slideLayouts/slideLayout1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"),
        ("/ppt/slides/slide1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"),
        ("/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"),
    ])),
    ("_rels/.rels", rels([("rId1", f"{OFFICE_REL}/officeDocument", "ppt/presentation.xml")])),
    ("ppt/presentation.xml", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="{A}" xmlns:r="{OFFICE_REL}" xmlns:p="{P}">'
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
        '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>'
        '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>'
        '</p:presentation>'),
    ("ppt/_rels/presentation.xml.rels", rels([
        ("rId1", f"{OFFICE_REL}/slideMaster", "slideMasters/slideMaster1.xml"),
        ("rId2", f"{OFFICE_REL}/slide", "slides/slide1.xml"),
    ])),
    ("ppt/slideMasters/slideMaster1.xml", slide_master),
    ("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels([
        ("rId1", f"{OFFICE_REL}/slideLayout", "../slideLayouts/slideLayout1.xml"),
        ("rId2", f"{OFFICE_REL}/theme", "../theme/theme1.xml"),
    ])),
    ("ppt/slideLayouts/slideLayout1.xml", slide_layout),
    ("ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels([
        ("rId1", f"{OFFICE_REL}/slideMaster", "../slideMasters/slideMaster1.xml"),
    ])),
    ("ppt/theme/theme1.xml", theme),
    ("ppt/slides/slide1.xml", slide1),
    ("ppt/slides/_rels/slide1.xml.rels", rels([
        ("rId1", f"{OFFICE_REL}/slideLayout", "../slideLayouts/slideLayout1.xml"),
    ])),
])
