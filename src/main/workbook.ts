import path from "node:path";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import {
  DOMParser,
  XMLSerializer,
  type Document,
  type Element,
} from "@xmldom/xmldom";
import {
  bilingual,
  normalizedMaterials,
  TBC,
  RISK_OPINION,
  missingSummary,
  type TechPack,
  type Material,
  type FigureImage,
} from "../shared/model";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DRAW =
  "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const parser = new DOMParser({
  onError: (level, message) => {
    if (level !== "warning") throw new Error(`模板XML无效：${message}`);
  },
});
const serialize = (doc: Document) => new XMLSerializer().serializeToString(doc);
const parse = (text: string) => parser.parseFromString(text, "application/xml");
const elements = (parent: Document | Element, name: string): Element[] =>
  Array.from(parent.getElementsByTagNameNS("*", name));
const children = (parent: Element, name: string): Element[] =>
  Array.from(parent.childNodes).filter(
    (n) => n.nodeType === 1 && (n as Element).localName === name,
  ) as Element[];
const first = (parent: Element, name: string) => children(parent, name)[0];
function node(
  doc: Document,
  name: string,
  attrs: Record<string, string | number> = {},
  namespace = NS,
): Element {
  const e = doc.createElementNS(namespace, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
function colName(index: number): string {
  let result = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26))
    result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
}
function colIndex(name: string): number {
  return [...name].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
}
function splitAddress(address: string) {
  const match = /^([A-Z]+)(\d+)$/.exec(address);
  if (!match) throw new Error(`单元格地址错误：${address}`);
  return { col: colIndex(match[1]), row: Number(match[2]) };
}
function areaCoords(area: string) {
  const [a, b = a] = area.split(":");
  const start = splitAddress(a),
    end = splitAddress(b);
  return { start, end };
}

class Sheet {
  private data: Element;
  constructor(
    public doc: Document,
    public name: string,
    public file: string,
    private book: TemplateBook,
  ) {
    this.data = elements(doc, "sheetData")[0];
    if (!this.data) throw new Error(`模板工作表缺少内容：${name}`);
  }
  row(index: number): Element {
    let row = children(this.data, "row").find(
      (r) => Number(r.getAttribute("r")) === index,
    );
    if (!row) {
      row = node(this.doc, "row", { r: index });
      const next = children(this.data, "row").find(
        (r) => Number(r.getAttribute("r")) > index,
      );
      this.data.insertBefore(row, next || null);
    }
    return row;
  }
  cell(address: string): Element {
    const { col, row } = splitAddress(address),
      r = this.row(row);
    let cell = children(r, "c").find((c) => c.getAttribute("r") === address);
    if (!cell) {
      cell = node(this.doc, "c", { r: address });
      const next = children(r, "c").find(
        (c) => splitAddress(c.getAttribute("r")!).col > col,
      );
      r.insertBefore(cell, next || null);
    }
    return cell;
  }
  value(address: string): string | number | null {
    const cell = this.cell(address);
    const type = cell.getAttribute("t");
    if (type === "inlineStr")
      return elements(cell, "t")
        .map((t) => t.textContent || "")
        .join("");
    const value = first(cell, "v")?.textContent;
    if (value === undefined || value === null) return null;
    if (type === "s") return this.book.strings[Number(value)] ?? null;
    return type === "str"
      ? value
      : Number.isFinite(Number(value))
        ? Number(value)
        : value;
  }
  set(
    address: string,
    value: string | number | null | undefined,
    style?: number,
  ) {
    const cell = this.cell(address);
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    cell.removeAttribute("t");
    if (style !== undefined) cell.setAttribute("s", String(style));
    if (value === null || value === undefined || value === "") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("尺寸或数量必须是有效数字");
      const v = node(this.doc, "v");
      v.appendChild(this.doc.createTextNode(String(value)));
      cell.appendChild(v);
    } else {
      // Inline strings also prevent leading '=' or external-link text from becoming formulas.
      cell.setAttribute("t", "inlineStr");
      const is = node(this.doc, "is"),
        t = node(this.doc, "t");
      t.setAttribute("xml:space", "preserve");
      t.appendChild(this.doc.createTextNode(value));
      is.appendChild(t);
      cell.appendChild(is);
    }
  }
  style(address: string): number {
    return Number(this.cell(address).getAttribute("s") || 0);
  }
  height(row: number, height: number) {
    const r = this.row(row);
    r.setAttribute("ht", String(height));
    r.setAttribute("customHeight", "1");
    r.removeAttribute("hidden");
  }
  width(col: number): number {
    const found = elements(this.doc, "col").find(
      (e) =>
        Number(e.getAttribute("min")) <= col &&
        Number(e.getAttribute("max")) >= col,
    );
    return (
      Number(
        found?.getAttribute("width") ||
          elements(this.doc, "sheetFormatPr")[0]?.getAttribute(
            "defaultColWidth",
          ) ||
          9,
      ) *
        7 +
      5
    );
  }
  clear(area: string) {
    const { start, end } = areaCoords(area);
    for (const r of children(this.data, "row")) {
      const row = Number(r.getAttribute("r"));
      if (row < start.row || row > end.row) continue;
      for (const c of children(r, "c")) {
        const col = splitAddress(c.getAttribute("r")!).col;
        if (col >= start.col && col <= end.col)
          this.set(c.getAttribute("r")!, null);
      }
    }
  }
  unmerge(area: string) {
    const { start, end } = areaCoords(area);
    const merges = elements(this.doc, "mergeCells")[0];
    if (!merges) return;
    for (const m of children(merges, "mergeCell")) {
      const a = areaCoords(m.getAttribute("ref")!);
      if (
        a.start.col <= end.col &&
        a.end.col >= start.col &&
        a.start.row <= end.row &&
        a.end.row >= start.row
      )
        merges.removeChild(m);
    }
    merges.setAttribute("count", String(children(merges, "mergeCell").length));
  }
  merge(area: string) {
    this.unmerge(area);
    let merges = elements(this.doc, "mergeCells")[0];
    if (!merges) {
      merges = node(this.doc, "mergeCells");
      const root = this.doc.documentElement!;
      const next = Array.from(root.childNodes).find(
        (n) =>
          n.nodeType === 1 &&
          [
            "conditionalFormatting",
            "dataValidations",
            "printOptions",
            "pageMargins",
            "pageSetup",
            "drawing",
            "extLst",
          ].includes((n as Element).localName || ""),
      );
      root.insertBefore(merges, next || null);
    }
    merges.appendChild(node(this.doc, "mergeCell", { ref: area }));
    merges.setAttribute("count", String(children(merges, "mergeCell").length));
  }
  merged(area: string, value: string, height: number, style?: number) {
    this.merge(area);
    this.set(area.split(":")[0], value, style);
    this.height(splitAddress(area.split(":")[0]).row, height);
  }
  async drawing(keepCover = false, keepHeader = false) {
    const ref = elements(this.doc, "drawing")[0];
    if (!ref) return;
    const relFile = path.posix.join(
      path.posix.dirname(this.file),
      "_rels",
      path.posix.basename(this.file) + ".rels",
    );
    const rels = await this.book.xml(relFile);
    const rel = elements(rels, "Relationship").find(
      (r) => r.getAttribute("Id") === ref.getAttributeNS(OFFICE_REL, "id"),
    );
    if (!rel) return;
    const file = path.posix
      .resolve("/" + path.posix.dirname(this.file), rel.getAttribute("Target")!)
      .slice(1);
    if (keepCover) return;
    if (keepHeader) {
      const doc = await this.book.xml(file);
      for (const anchor of Array.from(doc.documentElement!.childNodes))
        if (anchor.nodeType === 1) {
          const from = elements(anchor as Element, "from")[0];
          const row = from
            ? Number(elements(from, "row")[0]?.textContent)
            : 999;
          if (row > 1) doc.documentElement!.removeChild(anchor);
        }
      this.book.saveXml(file, doc);
    } else {
      ref.parentNode!.removeChild(ref);
    }
  }
  async picture(
    data: string,
    address: string,
    maxWidth: number,
    maxHeight: number,
  ) {
    const bytes = Buffer.from(data.split(",")[1] || "", "base64");
    if (!bytes.length) return;
    const dim = pngSize(bytes);
    const scale = Math.min(maxWidth / dim.width, maxHeight / dim.height);
    const relFile = path.posix.join(
      path.posix.dirname(this.file),
      "_rels",
      path.posix.basename(this.file) + ".rels",
    );
    const rels = await this.book.optionalXml(
      relFile,
      `<Relationships xmlns="${REL}"/>`,
    );
    let ref = elements(this.doc, "drawing")[0];
    let drawingFile: string;
    if (!ref) {
      const id = "rId" + randomUUID().replaceAll("-", "");
      drawingFile = `xl/drawings/tp-${randomUUID()}.xml`;
      ref = node(this.doc, "drawing");
      ref.setAttributeNS(OFFICE_REL, "r:id", id);
      const root = this.doc.documentElement!;
      root.insertBefore(ref, elements(this.doc, "extLst")[0] || null);
      rels.documentElement!.appendChild(
        node(
          rels,
          "Relationship",
          {
            Id: id,
            Type: OFFICE_REL + "/drawing",
            Target: "../drawings/" + path.posix.basename(drawingFile),
          },
          REL,
        ),
      );
      await this.book.contentType(
        "/" + drawingFile,
        "application/vnd.openxmlformats-officedocument.drawingingml.drawing+xml".replace(
          "drawingingml",
          "drawingml",
        ),
      );
    } else {
      const rel = elements(rels, "Relationship").find(
        (r) => r.getAttribute("Id") === ref.getAttributeNS(OFFICE_REL, "id"),
      );
      if (!rel) throw new Error("模板图片关系无效");
      drawingFile = path.posix
        .resolve(
          "/" + path.posix.dirname(this.file),
          rel.getAttribute("Target")!,
        )
        .slice(1);
    }
    const drawing = await this.book.optionalXml(
      drawingFile,
      `<xdr:wsDr xmlns:xdr="${DRAW}" xmlns:a="${A}" xmlns:r="${OFFICE_REL}"/>`,
    );
    const drawingRelsFile = path.posix.join(
      path.posix.dirname(drawingFile),
      "_rels",
      path.posix.basename(drawingFile) + ".rels",
    );
    const drawingRels = await this.book.optionalXml(
      drawingRelsFile,
      `<Relationships xmlns="${REL}"/>`,
    );
    const imageName = `tp-${randomUUID()}.png`,
      imageId = "rId" + randomUUID().replaceAll("-", "");
    this.book.zip.file("xl/media/" + imageName, bytes);
    drawingRels.documentElement!.appendChild(
      node(
        drawingRels,
        "Relationship",
        {
          Id: imageId,
          Type: OFFICE_REL + "/image",
          Target: "../media/" + imageName,
        },
        REL,
      ),
    );
    const anchor = node(drawing, "xdr:oneCellAnchor", {}, DRAW),
      from = node(drawing, "xdr:from", {}, DRAW),
      position = splitAddress(address);
    for (const [key, value] of Object.entries({
      col: position.col - 1,
      colOff: 47625,
      row: position.row - 1,
      rowOff: 47625,
    })) {
      const child = node(drawing, "xdr:" + key, {}, DRAW);
      child.appendChild(drawing.createTextNode(String(value)));
      from.appendChild(child);
    }
    anchor.appendChild(from);
    const w = Math.round(dim.width * scale * 9525),
      h = Math.round(dim.height * scale * 9525);
    anchor.appendChild(node(drawing, "xdr:ext", { cx: w, cy: h }, DRAW));
    const pic = node(drawing, "xdr:pic", {}, DRAW),
      nv = node(drawing, "xdr:nvPicPr", {}, DRAW);
    nv.appendChild(
      node(
        drawing,
        "xdr:cNvPr",
        { id: elements(drawing, "pic").length + 100, name: imageName },
        DRAW,
      ),
    );
    nv.appendChild(node(drawing, "xdr:cNvPicPr", {}, DRAW));
    pic.appendChild(nv);
    const fill = node(drawing, "xdr:blipFill", {}, DRAW),
      blip = node(drawing, "a:blip", {}, A);
    blip.setAttributeNS(OFFICE_REL, "r:embed", imageId);
    fill.appendChild(blip);
    const stretch = node(drawing, "a:stretch", {}, A);
    stretch.appendChild(node(drawing, "a:fillRect", {}, A));
    fill.appendChild(stretch);
    pic.appendChild(fill);
    const shape = node(drawing, "xdr:spPr", {}, DRAW),
      xfrm = node(drawing, "a:xfrm", {}, A);
    xfrm.appendChild(node(drawing, "a:off", { x: 0, y: 0 }, A));
    xfrm.appendChild(node(drawing, "a:ext", { cx: w, cy: h }, A));
    shape.appendChild(xfrm);
    const geom = node(drawing, "a:prstGeom", { prst: "rect" }, A);
    geom.appendChild(node(drawing, "a:avLst", {}, A));
    shape.appendChild(geom);
    pic.appendChild(shape);
    anchor.appendChild(pic);
    anchor.appendChild(node(drawing, "xdr:clientData", {}, DRAW));
    drawing.documentElement!.appendChild(anchor);
    this.book.saveXml(relFile, rels);
    this.book.saveXml(drawingFile, drawing);
    this.book.saveXml(drawingRelsFile, drawingRels);
    await this.book.ensurePng();
  }
  print(area: string) {
    const { end } = areaCoords(area),
      width = Array.from(
        { length: end.col },
        (_, i) => this.width(i + 1) * 0.75,
      ).reduce((a, b) => a + b, 0);
    const height = Array.from({ length: end.row }, (_, i) =>
      Number(this.row(i + 1).getAttribute("ht") || 15),
    ).reduce((a, b) => a + b, 0);
    const orientation =
      Math.min(559 / width, 806 / height) >= Math.min(806 / width, 559 / height)
        ? "portrait"
        : "landscape";
    const root = this.doc.documentElement!;
    let props = elements(this.doc, "sheetPr")[0];
    if (!props) {
      props = node(this.doc, "sheetPr");
      root.insertBefore(props, root.firstChild);
    }
    let fit = first(props, "pageSetUpPr");
    if (!fit) {
      fit = node(this.doc, "pageSetUpPr");
      props.appendChild(fit);
    }
    fit.setAttribute("fitToPage", "1");
    for (const tag of [
      "printOptions",
      "pageMargins",
      "pageSetup",
      "rowBreaks",
      "colBreaks",
    ])
      for (const e of elements(this.doc, tag)) e.parentNode!.removeChild(e);
    const before =
      Array.from(root.childNodes).find(
        (n) =>
          n.nodeType === 1 &&
          ["headerFooter", "drawing", "legacyDrawing", "extLst"].includes(
            (n as Element).localName || "",
          ),
      ) || null;
    for (const e of [
      node(this.doc, "printOptions", {
        horizontalCentered: 1,
        gridLines: 0,
        headings: 0,
      }),
      node(this.doc, "pageMargins", {
        left: 0.25,
        right: 0.25,
        top: 0.25,
        bottom: 0.25,
        header: 0.1,
        footer: 0.1,
      }),
      node(this.doc, "pageSetup", {
        paperSize: 9,
        orientation,
        fitToWidth: 1,
        fitToHeight: 1,
      }),
    ])
      root.insertBefore(e, before);
    const dimension = elements(this.doc, "dimension")[0];
    dimension?.setAttribute("ref", area);
    this.book.printAreas.set(this.name, area);
    return { name: this.name, area, orientation };
  }
}

function pngSize(buffer: Buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG")
    throw new Error("图片必须为PNG格式");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
class TemplateBook {
  strings: string[] = [];
  sheets: Sheet[] = [];
  docs = new Map<string, Document>();
  printAreas = new Map<string, string>();
  styles!: Document;
  constructor(public zip: JSZip) {}
  async xml(file: string) {
    const cached = this.docs.get(file);
    if (cached) return cached;
    const entry = this.zip.file(file);
    if (!entry) throw new Error(`模板缺少文件：${file}`);
    const doc = parse(await entry.async("string"));
    this.docs.set(file, doc);
    return doc;
  }
  async optionalXml(file: string, empty: string) {
    if (this.docs.has(file)) return this.docs.get(file)!;
    if (this.zip.file(file)) return this.xml(file);
    const doc = parse(empty);
    this.docs.set(file, doc);
    return doc;
  }
  saveXml(file: string, doc: Document) {
    this.docs.set(file, doc);
  }
  async contentType(file: string, type: string) {
    const doc = await this.xml("[Content_Types].xml");
    if (
      !elements(doc, "Override").some(
        (e) => e.getAttribute("PartName") === file,
      )
    )
      doc.documentElement!.appendChild(
        node(doc, "Override", { PartName: file, ContentType: type }, CT),
      );
  }
  async ensurePng() {
    const doc = await this.xml("[Content_Types].xml");
    if (
      !elements(doc, "Default").some(
        (e) => e.getAttribute("Extension") === "png",
      )
    )
      doc.documentElement!.appendChild(
        node(
          doc,
          "Default",
          { Extension: "png", ContentType: "image/png" },
          CT,
        ),
      );
  }
  async initialize() {
    const strings = this.zip.file("xl/sharedStrings.xml");
    if (strings)
      this.strings = elements(parse(await strings.async("string")), "si").map(
        (si) =>
          elements(si, "t")
            .map((t) => t.textContent || "")
            .join(""),
      );
    const workbook = await this.xml("xl/workbook.xml"),
      rels = await this.xml("xl/_rels/workbook.xml.rels");
    this.styles = await this.xml("xl/styles.xml");
    for (const entry of elements(workbook, "sheet")) {
      const id = entry.getAttributeNS(OFFICE_REL, "id"),
        rel = elements(rels, "Relationship").find(
          (r) => r.getAttribute("Id") === id,
        );
      if (!rel) continue;
      const file = path.posix
        .resolve("/xl", rel.getAttribute("Target")!)
        .slice(1);
      this.sheets.push(
        new Sheet(
          await this.xml(file),
          entry.getAttribute("name") || "",
          file,
          this,
        ),
      );
    }
  }
  get(name: string) {
    const sheet = this.sheets.find((s) => s.name.trim() === name);
    if (!sheet)
      throw new Error(
        `模板缺少「${name}」工作表，请选择内置模板或相同格式的模板。`,
      );
    return sheet;
  }
  style(
    base: number,
    {
      size = 12,
      bold = false,
      fill = false,
      numberFormat,
    }: {
      size?: number;
      bold?: boolean;
      fill?: boolean;
      numberFormat?: string;
    } = {},
  ) {
    const xfs = elements(this.styles, "cellXfs")[0],
      fonts = elements(this.styles, "fonts")[0],
      xf = (children(xfs, "xf")[base] || children(xfs, "xf")[0]).cloneNode(
        true,
      ) as Element;
    const font = node(this.styles, "font");
    font.appendChild(node(this.styles, "sz", { val: size }));
    font.appendChild(node(this.styles, "name", { val: "Arial" }));
    if (bold) font.appendChild(node(this.styles, "b"));
    fonts.appendChild(font);
    fonts.setAttribute("count", String(children(fonts, "font").length));
    xf.setAttribute("fontId", String(children(fonts, "font").length - 1));
    xf.setAttribute("applyFont", "1");
    const fills = elements(this.styles, "fills")[0];
    let fillIndex = 0;
    if (fill) {
      const f = node(this.styles, "fill"),
        pattern = node(this.styles, "patternFill", { patternType: "solid" });
      pattern.appendChild(node(this.styles, "fgColor", { rgb: "FFFFFF00" }));
      pattern.appendChild(node(this.styles, "bgColor", { indexed: 64 }));
      f.appendChild(pattern);
      fillIndex = children(fills, "fill").length;
      fills.appendChild(f);
      fills.setAttribute("count", String(children(fills, "fill").length));
    }
    xf.setAttribute("fillId", String(fillIndex));
    xf.setAttribute("applyFill", "1");
    let alignment = first(xf, "alignment");
    if (!alignment) {
      alignment = node(this.styles, "alignment");
      xf.appendChild(alignment);
    }
    alignment.setAttribute("wrapText", "1");
    alignment.setAttribute("vertical", "center");
    alignment.removeAttribute("shrinkToFit");
    if (numberFormat) {
      let formats = elements(this.styles, "numFmts")[0];
      if (!formats) {
        formats = node(this.styles, "numFmts", { count: 0 });
        this.styles.documentElement!.insertBefore(
          formats,
          this.styles.documentElement!.firstChild,
        );
      }
      const ids = children(formats, "numFmt").map((f) =>
        Number(f.getAttribute("numFmtId")),
      );
      const id = Math.max(163, ...ids) + 1;
      formats.appendChild(
        node(this.styles, "numFmt", { numFmtId: id, formatCode: numberFormat }),
      );
      formats.setAttribute("count", String(ids.length + 1));
      xf.setAttribute("numFmtId", String(id));
      xf.setAttribute("applyNumberFormat", "1");
    }
    xfs.appendChild(xf);
    xfs.setAttribute("count", String(children(xfs, "xf").length));
    return children(xfs, "xf").length - 1;
  }
  async finish() {
    const workbook = await this.xml("xl/workbook.xml");
    let names = elements(workbook, "definedNames")[0];
    if (!names) {
      names = node(workbook, "definedNames");
      const calc = elements(workbook, "calcPr")[0];
      workbook.documentElement!.insertBefore(names, calc || null);
    }
    for (const item of children(names, "definedName"))
      if (
        [
          "Print_Area",
          "_xlnm.Print_Area",
          "Print_Titles",
          "_xlnm.Print_Titles",
        ].includes(item.getAttribute("name") || "")
      )
        names.removeChild(item);
    for (const [name, area] of this.printAreas) {
      const item = node(workbook, "definedName", {
        name: "_xlnm.Print_Area",
        localSheetId: this.sheets.findIndex((s) => s.name === name),
      });
      item.appendChild(
        workbook.createTextNode(
          `'${name.replaceAll("'", "''")}'!${area.replace(/([A-Z]+)(\d+)/g, "$$$1$$$2")}`,
        ),
      );
      names.appendChild(item);
    }
    // Empty f nodes from converted .xls files must not hide overwritten literal values.
    for (const sh of this.sheets)
      for (const formula of elements(sh.doc, "f"))
        if (!formula.textContent?.trim())
          formula.parentNode!.removeChild(formula);
    for (const [file, doc] of this.docs) this.zip.file(file, serialize(doc));
    return this.zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
  }
}

export async function inspectTemplate(bytes: Buffer) {
  const book = new TemplateBook(await JSZip.loadAsync(bytes));
  await book.initialize();
  for (const name of [
    "制单封面",
    "数量搭配及打样要求",
    "CAD",
    "CAD-1",
    "CAD-1 (2)",
    "面辅料配色表",
    "尺寸表",
    "风险评估会",
    "客人意见或邮件",
    "耗料单",
    "样衣面料留卡(2.0版)",
  ])
    book.get(name);
  return book.sheets.map((s) => s.name);
}
function materialValues(m: Material): (string | number | null)[] {
  const extra = m.colors
    .slice(2)
    .map((color, i) => `配色${i + 3} / COLORWAY ${i + 3}: ${color}`)
    .join("\n");
  return [
    bilingual(m.nameZh, m.nameEn),
    bilingual(m.specZh, m.specEn),
    m.colors[0] || TBC,
    m.colors[1] || null,
    m.quantity,
    bilingual(m.unitZh, m.unitEn),
    bilingual(m.placementZh, m.placementEn),
    [m.notesZh, m.notesEn, extra].filter(Boolean).join("\n") || null,
  ];
}
function fittedHeight(
  values: (string | number | null)[],
  widths: number[],
  size: number,
  min = 40,
) {
  let lines = 1;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value == null) continue;
    let count = 0;
    for (const line of String(value).split("\n")) {
      const units = [...line].reduce(
        (n, c) => n + (/[\u2e80-\uffff]/u.test(c) ? 1 : 0.56),
        0,
      );
      count += Math.max(1, Math.ceil((units * size) / (widths[i] * 0.75 - 9)));
    }
    lines = Math.max(lines, count);
  }
  return Math.max(min, lines * size * 1.25 + 12);
}

export async function generateWorkbook(
  template: Buffer,
  data: TechPack,
  figures: FigureImage[] = [],
) {
  const book = new TemplateBook(await JSZip.loadAsync(template));
  await book.initialize();
  for (const name of [
    "制单封面",
    "数量搭配及打样要求",
    "CAD",
    "CAD-1",
    "CAD-1 (2)",
    "面辅料配色表",
    "尺寸表",
    "风险评估会",
    "客人意见或邮件",
    "耗料单",
    "样衣面料留卡(2.0版)",
  ])
    book.get(name);
  const meta = data.meta,
    style = [meta.styleNumber, meta.styleName].filter(Boolean).join(" ") || TBC;
  const description = bilingual(meta.descriptionZh, meta.descriptionEn),
    materials = normalizedMaterials(data),
    fabrics = materials.filter(
      (m) => m.kind === "fabric" || m.kind === "interlining",
    );
  const cover = book.get("制单封面"),
    sample = book.get("数量搭配及打样要求"),
    bom = book.get("面辅料配色表"),
    spec = book.get("尺寸表"),
    risk = book.get("风险评估会"),
    cons = book.get("耗料单"),
    card = book.get("样衣面料留卡(2.0版)");
  const regular = book.style(bom.style("A6"), { size: 12 }),
    heading = book.style(bom.style("A5"), { size: 12, bold: true, fill: true }),
    plainBold = book.style(bom.style("A6"), { size: 12, bold: true });
  const compact = book.style(cons.style("E6"), { size: 10 }),
    label = book.style(risk.style("D7"), { size: 11 });
  const figure = (role: FigureImage["role"]) =>
    figures.filter((f) => f.role === role);
  const sheets: { name: string; area: string; orientation: string }[] = [];

  // Preserve the company logo and vertical cover title; replace only style fields.
  await cover.drawing(false, true);
  const coverStyle = book.style(cover.style("D35"), { size: 12, bold: true });
  for (const [cell, value] of Object.entries({
    D33: [meta.brand, meta.customer].filter(Boolean).join(" / ") || TBC,
    D34: meta.orderNumber || TBC,
    D35: style,
    D36: description,
    D37: meta.merchandiser || TBC,
    D38: TBC,
    D39: meta.issueDate || TBC,
  }))
    cover.set(cell, value, coverStyle);
  for (const [cell, value] of Object.entries({
    B33: "客户 / CUSTOMER",
    B34: "订单号 / ORDER",
    B35: "款号 / STYLE",
    B36: "款式 / DESCRIPTION",
    B37: "跟单 / MERCHANDISER",
    B38: "经理审核 / APPROVAL",
    B39: "发单日期 / ISSUE DATE",
  }))
    cover.set(cell, value, coverStyle);
  for (let r = 33; r <= 39; r++) cover.height(r, r === 36 ? 64 : 40);
  cover.merged(
    "F2:G2",
    "版师 / PATTERN MAKER: TBC",
    25,
    book.style(coverStyle, { size: 10 }),
  );
  if (figure("appearance")[0])
    await cover.picture(figure("appearance")[0].data, "F5", 120, 300);
  sheets.push(cover.print("A1:G39"));

  await sample.drawing();
  sample.clear("A3:J13");
  const small = book.style(sample.style("A3"), { size: 12 });
  for (const [cell, value] of Object.entries({
    A2: "数量搭配及打样要求 / SAMPLE REQUIREMENTS",
    A3: "订单号 / ORDER",
    B3: meta.orderNumber || TBC,
    D3: "工厂 / FACTORY",
    F3: meta.factory || TBC,
    G3: "样衣数量 / QTY",
    I3: meta.sampleQuantity ?? TBC,
    A4: "款号 / STYLE",
    B4: style,
    D4: "属性 / STAGE",
    F4: "开发 / DEVELOPMENT",
    G4: "样品交期 / DUE",
    I4: meta.dueDate || TBC,
    A5: "品名 / DESCRIPTION",
    B5: description,
    D5: "跟单 / MERCH.",
    F5: meta.merchandiser || TBC,
    G5: "发单日期 / ISSUE",
    I5: meta.issueDate || TBC,
  }))
    sample.set(cell, value, small);
  sample.height(3, 42);
  sample.height(4, 42);
  sample.height(5, 80);
  sample.height(6, 40);
  sample.height(7, 62);
  sample.set("A6", "配色 / COLORWAY", small);
  meta.sizeScale
    .slice(0, 7)
    .forEach((s, i) => sample.set(`${colName(i + 2)}6`, s, small));
  sample.set("I6", "总计 / TOTAL", small);
  sample.set(
    "A7",
    materials.find((m) => m.kind === "fabric")?.colors[0] || TBC,
    small,
  );
  for (let c = 2; c <= Math.min(8, meta.sizeScale.length + 1); c++)
    sample.set(
      `${colName(c)}7`,
      meta.sizeScale[c - 2] === meta.sampleSize
        ? (meta.sampleQuantity ?? TBC)
        : TBC,
      small,
    );
  sample.set("I7", meta.sampleQuantity ?? TBC, small);
  sample.set("A9", "总计 / TOTAL", small);
  sample.set("I9", meta.sampleQuantity ?? TBC, small);
  const samplingNotes = [
    `样码 / SAMPLE: ${meta.sampleSize || TBC}; 尺码 / SIZES: ${meta.sizeScale.join("-") || TBC}`,
    `数量、交期和工厂以确认信息为准。 / QTY, DUE DATE & FACTORY REQUIRE CONFIRMATION.`,
    `尺寸仅按提供的样码资料填写，不推算。 / USE PROVIDED SAMPLE-SIZE SPECS; NO GRADING INFERRED.`,
    `检验及交期条款另行确认。 / INSPECTION & DELIVERY TERMS REQUIRE CONFIRMATION.`,
  ];
  samplingNotes.forEach((n, i) =>
    sample.merged(`A${10 + i}:J${10 + i}`, n, 38, small),
  );
  sheets.push(sample.print("A1:J13"));

  // CAD panels retain original tabs, with source figures and editable translations.
  for (const [name, title, roles] of [
    ["CAD", "款式工艺图 / CONSTRUCTION", ["construction"]],
    [
      "CAD-1",
      "辅料及款式参考 / TRIM & STYLE REFERENCES",
      ["trimReference", "inspiration"],
    ],
    ["CAD-1 (2)", "唛头参考 / LABEL REFERENCES", ["labels"]],
  ] as const) {
    const sh = book.get(name);
    await sh.drawing();
    sh.unmerge("A3:H150");
    sh.clear("A3:H150");
    sh.set("A2", title);
    sh.merged(
      "A3:H3",
      `款号 / STYLE: ${style}; 品牌 / BRAND: ${meta.brand || TBC}; 样码 / SAMPLE: ${meta.sampleSize || TBC}`,
      30,
      small,
    );
    for (let row = 4; row <= 14; row++) sh.height(row, 38);
    sh.merge("A4:H14");
    const selected = roles.flatMap((r) => figure(r));
    for (const [index, image] of selected.entries()) {
      const paired = selected.length === 2;
      const address = paired
        ? index === 0
          ? "A4"
          : "E4"
        : `A${4 + index * 5}`;
      await sh.picture(
        image.data,
        address,
        paired ? 420 : 860,
        selected.length > 2 ? 250 : 530,
      );
    }
    if (!selected.length)
      sh.set("A4", "未提供对应图片 / SOURCE IMAGE NOT PROVIDED", regular);
    let row = 15;
    if (name === "CAD") {
      for (const item of data.construction) {
        sh.merged(
          `A${row}:B${row}`,
          bilingual(item.titleZh, item.titleEn),
          48,
          label,
        );
        const text = bilingual(item.detailZh, item.detailEn);
        const height = fittedHeight(
          [text],
          [
            Array.from({ length: 6 }, (_, i) => sh.width(i + 3)).reduce(
              (a, b) => a + b,
              0,
            ),
          ],
          12,
          50,
        );
        sh.merged(`C${row}:H${row}`, text, height, regular);
        row++;
      }
    } else if (name === "CAD-1 (2)") {
      for (const m of materials.filter((m) => m.kind === "label")) {
        const text = [
          bilingual(m.nameZh, m.nameEn),
          bilingual(m.specZh, m.specEn),
          bilingual(m.placementZh, m.placementEn),
          m.notesZh,
          m.notesEn,
        ]
          .filter(Boolean)
          .join("; ");
        sh.merged(
          `A${row}:H${row}`,
          text,
          fittedHeight([text], [860], 12, 48),
          regular,
        );
        row++;
      }
    } else {
      for (const image of selected) {
        sh.merged(
          `A${row}:H${row}`,
          image.caption || "参考图片 / REFERENCE IMAGE",
          40,
          regular,
        );
        row++;
      }
      sh.merged(
        `A${row}:H${row}`,
        "颜色及规格以面辅料表为准。 / COLORS & SPECS PER MATERIALS TABLE.",
        40,
        regular,
      );
      row++;
    }
    sheets.push(sh.print(`A1:H${Math.max(row - 1, 15)}`));
  }

  await bom.drawing();
  bom.unmerge("A5:H200");
  bom.clear("A5:H200");
  bom.set("A1", `${style} 面辅料搭配表 / BILL OF MATERIALS`);
  for (const [cell, value] of Object.entries({
    A2: "订单号 / ORDER",
    B2: meta.orderNumber || TBC,
    A3: "款号 / STYLE",
    B3: style,
    A4: "品名 / DESCRIPTION",
    B4: description,
    E2: "客户 / CUSTOMER",
    G2: [meta.brand, meta.customer].filter(Boolean).join(" / ") || TBC,
    E3: "跟单 / MERCH.",
    G3: meta.merchandiser || TBC,
    E4: "资料日期 / TP DATE",
    G4: meta.sourceDate || TBC,
    H3: null,
    H4: null,
  }))
    bom.set(cell, value, regular);
  for (const r of [2, 3, 4]) bom.height(r, 46);
  bom.height(4, fittedHeight([description], [bom.width(2)], 12, 60));
  bom.set("C2", null);
  if (figure("appearance")[0])
    await bom.picture(figure("appearance")[0].data, "C2", 110, 165);
  const headers = [
    "面料名称 / FABRIC",
    "规格 / SPEC",
    "配色1 / COLORWAY 1",
    "配色2 / COLORWAY 2",
    "数量 / QTY",
    "单位\nUNIT",
    "部位 / PLACEMENT",
    "备注 / NOTES",
  ];
  const unitHeading = book.style(heading, { size: 10, bold: true, fill: true });
  headers.forEach((v, i) =>
    bom.set(`${colName(i + 1)}5`, v, i === 5 ? unitHeading : heading),
  );
  bom.height(5, 48);
  let bomRow = 6;
  const widths = Array.from({ length: 8 }, (_, i) => bom.width(i + 1));
  for (const m of materials.filter((m) =>
    ["fabric", "interlining", "graphic"].includes(m.kind),
  )) {
    const values = materialValues(m);
    values.forEach((v, i) => bom.set(`${colName(i + 1)}${bomRow}`, v, regular));
    bom.height(bomRow, fittedHeight(values, widths, 12, 50));
    bomRow++;
  }
  headers
    .map((h, i) => (i === 0 ? "辅料名称 / TRIMS" : h))
    .forEach((v, i) =>
      bom.set(`${colName(i + 1)}${bomRow}`, v, i === 5 ? unitHeading : heading),
    );
  bom.height(bomRow++, 48);
  for (const m of materials.filter(
    (m) => m.kind === "trim" || m.kind === "label",
  )) {
    const values = materialValues(m);
    values.forEach((v, i) => bom.set(`${colName(i + 1)}${bomRow}`, v, regular));
    bom.height(bomRow, fittedHeight(values, widths, 12, 48));
    bomRow++;
  }
  bom.merged(
    `A${bomRow}:H${bomRow}`,
    "空白数量表示资料未提供；不是零用量。 / BLANK QTY = NOT PROVIDED, NOT ZERO.",
    34,
    book.style(regular, { size: 11 }),
  );
  sheets.push(bom.print(`A1:H${bomRow}`));

  // Dimensions remain numeric, with fraction formatting, never interpreted as dates.
  const specText = book.style(spec.style("A5"), { size: 18, bold: true }),
    specNumber = book.style(spec.style("C5"), {
      size: 18,
      bold: true,
      numberFormat: meta.unit === "inch" ? "# ?/?" : "0.##",
    });
  spec.unmerge("A5:E200");
  spec.clear("A5:E200");
  spec.set("A2", "样码尺寸表 / SAMPLE-SIZE MEASUREMENTS");
  spec.set("A3", `款号 / STYLE: ${style}`, specText);
  spec.set("C3", "单位 / UNIT:", specText);
  spec.set("E3", meta.unit === "inch" ? "英寸 / INCH" : "厘米 / CM", specText);
  spec.height(3, 45);
  [
    "测量部位 / POM",
    "中文说明 / CHINESE",
    meta.sampleSize || "样码 / SIZE",
    "样衣实测 / SAMPLE",
    "公差 / TOL +/-",
  ].forEach((v, i) =>
    spec.set(
      `${colName(i + 1)}4`,
      v,
      book.style(specText, { size: 16, bold: true }),
    ),
  );
  spec.height(4, 55);
  data.measurements.forEach((m, i) => {
    const row = i + 5;
    const values = [
      m.nameEn || TBC,
      m.nameZh || TBC,
      m.value ?? m.sourceValue ?? TBC,
      null,
      m.tolerance ?? TBC,
    ];
    values.forEach((v, c) =>
      spec.set(
        `${colName(c + 1)}${row}`,
        v,
        c === 2 || c === 4 ? specNumber : specText,
      ),
    );
    spec.height(
      row,
      fittedHeight(
        values,
        Array.from({ length: 5 }, (_, c) => spec.width(c + 1)),
        18,
        54,
      ),
    );
  });
  const last = data.measurements.length + 5;
  spec.merged(
    `A${last}:E${last}`,
    `资料日期 / TP DATE: ${meta.sourceDate || TBC}; 参考款 / REFERENCE: ${meta.reference || TBC}; 技术 / TECHNICAL: ${meta.technical || TBC}; 季节 / SEASON: ${meta.season || TBC}`,
    44,
    regular,
  );
  spec.merged(
    `A${last + 1}:E${last + 1}`,
    "仅填写资料提供的样码尺寸，不推算其他尺码。 / ONLY PROVIDED SAMPLE-SIZE SPECS; NO GRADING INFERRED.",
    40,
    regular,
  );
  sheets.push(spec.print(`A1:E${last + 1}`));

  // Meeting guidance is a template rule, not generated AI review commentary.
  const originalOpinion = Array.from({ length: 30 }, (_, i) =>
    risk.value(`A${i + 1}`),
  ).find((v) => typeof v === "string" && v.startsWith("风险评估会意见：")) as
    string | undefined;
  await risk.drawing();
  risk.unmerge("A6:G150");
  risk.clear("A6:G150");
  risk.set("A2", "【头样】风险评估会");
  for (const [cell, value] of Object.entries({
    B3: meta.issueDate || TBC,
    E3: TBC,
    G3: TBC,
    B4: meta.merchandiser || TBC,
    C4: TBC,
    E4: TBC,
    G4: null,
    B5: [meta.brand, meta.customer].filter(Boolean).join(" / ") || TBC,
    E5: style,
    G5: description,
  }))
    risk.set(cell, value, label);
  risk.height(3, 38);
  risk.height(4, 38);
  risk.height(5, fittedHeight([description], [risk.width(7)], 11, 72));
  for (const [i, v] of [
    "名称 / ITEM",
    "规格 / SPEC",
    "部位 / USE",
    "备注 / NOTES",
  ].entries())
    risk.set(`${colName(i + 4)}6`, v, label);
  risk.height(6, 30);
  for (const [i, m] of fabrics.entries()) {
    const row = i + 7;
    const values = [
      bilingual(m.nameZh, m.nameEn),
      bilingual(m.specZh, m.specEn),
      bilingual(m.placementZh, m.placementEn),
      m.colors.join("\n") || TBC,
    ];
    values.forEach((v, j) => risk.set(`${colName(j + 4)}${row}`, v, label));
    risk.height(
      row,
      fittedHeight(
        values,
        [risk.width(4), risk.width(5), risk.width(6), risk.width(7)],
        11,
        48,
      ),
    );
  }
  const opinionRow = fabrics.length + 7;
  risk.merge(`A6:C${opinionRow - 1}`);
  if (figure("appearance")[0])
    await risk.picture(figure("appearance")[0].data, "B6", 120, 180);
  risk.merged(
    `A${opinionRow}:G${opinionRow}`,
    originalOpinion || RISK_OPINION,
    50,
    plainBold,
  );
  for (let row = opinionRow + 1; row <= opinionRow + 6; row++)
    risk.merged(`A${row}:G${row}`, "", 38, regular);
  risk.merged(
    `A${opinionRow + 7}:G${opinionRow + 7}`,
    "签字 / SIGNATURE: __________________    日期 / DATE: __________________",
    36,
    regular,
  );
  sheets.push(risk.print(`A1:G${opinionRow + 7}`));

  // Customer mail is untouched: retain the source template's content and drawings.
  const mail = book.get("客人意见或邮件");
  const populated = elements(mail.doc, "c")
    .filter((c) => elements(c, "v").length || elements(c, "t").length)
    .map((c) => splitAddress(c.getAttribute("r")!));
  const mailRow = Math.max(1, ...populated.map((c) => c.row));
  sheets.push(mail.print(`A1:G${mailRow}`));

  await cons.drawing(false, true);
  cons.unmerge("A6:L150");
  cons.clear("A6:L150");
  cons.set("A1", "武汉多恩投资有限公司耗料申请单 / MATERIAL CONSUMPTION");
  cons.set("B3", "订单 / ORDER:", compact);
  cons.set("B4", "款号 / STYLE:", compact);
  cons.set("H3", "日期 / DATE:", compact);
  cons.set("D3", meta.orderNumber || TBC, compact);
  cons.set("I3", meta.issueDate || TBC, compact);
  cons.set("C4", style, compact);
  cons.set("H4", "耗料师 / REVIEWER: TBC", compact);
  cons.height(3, 32);
  cons.height(4, 32);
  const consHeaders = [
    "款号 / STYLE",
    "图 / SKETCH",
    "类别 / STAGE",
    "数量 / QTY",
    "物料 / MATERIAL",
    "部位 / USE",
    "净幅宽 / WIDTH",
    "经缩 / WARP",
    "纬缩 / WEFT",
    "净耗 / NET USE",
    "损耗 / WASTE",
    "报价耗料 / QUOTED",
  ];
  consHeaders.forEach((v, i) => cons.set(`${colName(i + 1)}5`, v, compact));
  cons.height(5, 48);
  fabrics.forEach((m, i) => {
    const row = i + 6;
    const values = [
      style,
      i === 0 ? "" : "见封面 / COVER",
      "开发 / DEV",
      meta.sampleQuantity ?? TBC,
      bilingual(m.nameZh, m.nameEn) +
        "\n" +
        bilingual(m.specZh, m.specEn) +
        "\n" +
        (m.colors[0] || TBC),
      bilingual(m.placementZh, m.placementEn),
      TBC,
      TBC,
      TBC,
      TBC,
      TBC,
      TBC,
    ];
    values.forEach((v, c) => cons.set(`${colName(c + 1)}${row}`, v, compact));
    cons.height(
      row,
      fittedHeight(
        values,
        Array.from({ length: 12 }, (_, c) => cons.width(c + 1)),
        10,
        70,
      ),
    );
  });
  if (figure("appearance")[0])
    await cons.picture(figure("appearance")[0].data, "B6", 58, 125);
  const consLast = fabrics.length + 7;
  cons.merged(
    `A${consLast}:L${consLast}`,
    "幅宽、缩水率、单耗和损耗率须测试/核算，不沿用旧款数值。 / WIDTH, SHRINKAGE, CONSUMPTION & WASTE: TBC.",
    40,
    compact,
  );
  cons.merged(
    `A${consLast + 1}:L${consLast + 1}`,
    `制单 / PREPARED BY: ${meta.merchandiser || TBC}`,
    30,
    compact,
  );
  sheets.push(cons.print(`A1:L${consLast + 1}`));

  await card.drawing();
  card.unmerge("A5:J250");
  card.clear("A5:J250");
  card.set("A2", "样衣面料留底卡 / FABRIC SWATCH CARD");
  for (const [cell, value] of Object.entries({
    A3: "客户 / CLIENT",
    C3: "款号 / STYLE",
    E3: "款式 / STYLE",
    G3: "跟单 / MERCH.",
    I3: "日期 / DATE",
  }))
    card.set(cell, value, label);
  for (const [cell, value] of Object.entries({
    B3: [meta.brand, meta.customer].filter(Boolean).join(" / ") || TBC,
    D3: style,
    F3: description,
    H3: meta.merchandiser || TBC,
    J3: meta.issueDate || TBC,
    L1: meta.brand || TBC,
    L12: style,
    L40: meta.descriptionZh || TBC,
    L55: meta.merchandiser || TBC,
  }))
    card.set(cell, value, cell.startsWith("L") ? undefined : label);
  card.height(3, fittedHeight([description], [card.width(6)], 11, 54));
  const block = 16,
    cardEnd = Math.max(69, fabrics.length * block + 5);
  for (let r = 5; r <= cardEnd; r++) card.height(r, 11);
  for (const [i, m] of fabrics.entries()) {
    const start = 6 + i * block;
    const texts = [
      bilingual(m.nameZh, m.nameEn) + ": " + bilingual(m.specZh, m.specEn),
      `颜色 / COLOR: ${m.colors[0] || TBC}; 部位 / USE: ${bilingual(m.placementZh, m.placementEn)}`,
      "供应商、幅宽、价格、收布日期/米数 / SUPPLIER, WIDTH, PRICE, RECEIPT DATE/LENGTH: TBC",
      "实样粘贴区 / ATTACH PHYSICAL SWATCH HERE",
    ];
    for (const [j, offset] of [0, 1, 2, 4].entries())
      card.merged(
        `A${start + offset}:J${start + offset}`,
        texts[j],
        [48, 34, 30, 26][j],
        regular,
      );
  }
  sheets.push(card.print(`A1:M${cardEnd}`));
  // Clear previous style identifiers only in editable metadata; original mail stays untouched.
  const warnings = missingSummary(data);
  return {
    buffer: await book.finish(),
    sheets: book.sheets
      .map((s) => sheets.find((p) => p.name === s.name)!)
      .filter(Boolean),
    warnings,
  };
}
