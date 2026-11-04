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
  RISK_OPINION,
  missingSummary,
  type TechPack,
  type Material,
  type FigureImage,
  type PlacedAnnotation,
} from "../shared/model";
import {
  chinese,
  chineseColor,
  chineseExportWarnings,
  chineseLabel,
  CHINESE_TBC,
} from "../shared/chinese-text";
import { annotationWarnings } from "../shared/cad-annotations";
import {
  normalizeLabel,
  scalarField,
  templateRole,
  templateTables,
  sampleTotalRow,
  type TemplateCell,
  type TemplateSheet,
  type TemplateTable,
} from "./template-layout";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DRAW =
  "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const TBC = CHINESE_TBC;
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
    if (value === undefined || value === null || value === "") return null;
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
    const originalStyle = this.style(address);
    const formula = first(cell, "f");
    // 保留模板的计算和跨表引用；新资料只更新缓存值，Excel 打开后重新计算。
    // 旧款 DISPIMG 图片仍按既有流程替换为新 PDF 图片。
    const preservedFormula =
      formula &&
      (formula.textContent?.trim() || formula.hasAttribute("t")) &&
      !/DISPIMG/i.test(formula.textContent || "")
        ? formula
        : undefined;
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    cell.removeAttribute("t");
    if (preservedFormula) cell.appendChild(preservedFormula);
    if (style !== undefined)
      cell.setAttribute(
        "s",
        String(this.book.preserveBorder(style, originalStyle)),
      );
    if (value === null || value === undefined || value === "") return;
    if (typeof value === "number" || preservedFormula) {
      if (typeof value === "number" && !Number.isFinite(value))
        throw new Error("尺寸或数量必须是有效数字");
      if (typeof value === "string") cell.setAttribute("t", "str");
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
    const cell = this.cell(address);
    if (cell.hasAttribute("s")) return Number(cell.getAttribute("s"));
    const { row, col } = splitAddress(address);
    const rowStyle = this.row(row).getAttribute("s");
    const column = elements(this.doc, "col").find(
      (c) =>
        Number(c.getAttribute("min")) <= col &&
        Number(c.getAttribute("max")) >= col,
    );
    return Number(rowStyle || column?.getAttribute("style") || 0);
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
    if (["1", "true"].includes(found?.getAttribute("hidden") || "")) return 0;
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
    if (!ref) return [];
    const relFile = path.posix.join(
      path.posix.dirname(this.file),
      "_rels",
      path.posix.basename(this.file) + ".rels",
    );
    const rels = await this.book.xml(relFile);
    const rel = elements(rels, "Relationship").find(
      (r) => r.getAttribute("Id") === ref.getAttributeNS(OFFICE_REL, "id"),
    );
    if (!rel) return [];
    const file = path.posix
      .resolve("/" + path.posix.dirname(this.file), rel.getAttribute("Target")!)
      .slice(1);
    const original = await this.book.xml(file);
    const slots = [
      ...elements(original, "oneCellAnchor"),
      ...elements(original, "twoCellAnchor"),
    ].flatMap((anchor) => {
      const from = elements(anchor, "from")[0];
      if (!from || !elements(anchor, "pic").length) return [];
      const col = Number(elements(from, "col")[0]?.textContent) + 1;
      const row = Number(elements(from, "row")[0]?.textContent) + 1;
      const ext = elements(anchor, "ext")[0];
      return [
        {
          col,
          row,
          address: `${colName(col)}${row}`,
          width: Number(ext?.getAttribute("cx") || 0) / 9525,
          height: Number(ext?.getAttribute("cy") || 0) / 9525,
        },
      ];
    });
    if (keepCover) return slots;
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
      // 清除旧绘图的活动关系和部件，避免其他Excel读取器重新显示旧款图片。
      rel.parentNode!.removeChild(rel);
      this.book.saveXml(relFile, rels);
      const drawingRels = path.posix.join(
        path.posix.dirname(file),
        "_rels",
        path.posix.basename(file) + ".rels",
      );
      this.book.docs.delete(file);
      this.book.zip.remove(file);
      this.book.docs.delete(drawingRels);
      this.book.zip.remove(drawingRels);
      const types = await this.book.xml("[Content_Types].xml");
      for (const entry of elements(types, "Override"))
        if (entry.getAttribute("PartName") === "/" + file)
          entry.parentNode!.removeChild(entry);
    }
    return slots;
  }
  async picture(
    data: string,
    address: string,
    maxWidth: number,
    maxHeight: number,
    annotations: PlacedAnnotation[] = [],
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
        "application/vnd.openxmlformats-officedocument.drawing+xml",
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
    const position = splitAddress(address);
    const originX =
      5 +
      Array.from({ length: position.col - 1 }, (_, i) =>
        this.width(i + 1),
      ).reduce((a, b) => a + b, 0);
    const originY =
      5 +
      Array.from(
        { length: position.row - 1 },
        (_, i) =>
          (Number(
            this.row(i + 1).getAttribute("ht") ||
              elements(this.doc, "sheetFormatPr")[0]?.getAttribute(
                "defaultRowHeight",
              ) ||
              15,
          ) *
            4) /
          3,
      ).reduce((a, b) => a + b, 0);
    // 带标注的底图与文字统一使用标准绝对锚点，避免列宽换算差异或越界单元格偏移。
    const anchor = node(
      drawing,
      annotations.length ? "xdr:absoluteAnchor" : "xdr:oneCellAnchor",
      {},
      DRAW,
    );
    if (annotations.length) {
      anchor.appendChild(
        node(
          drawing,
          "xdr:pos",
          { x: Math.round(originX * 9525), y: Math.round(originY * 9525) },
          DRAW,
        ),
      );
    } else {
      const from = node(drawing, "xdr:from", {}, DRAW);
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
    }
    const w = Math.round(dim.width * scale * 9525),
      h = Math.round(dim.height * scale * 9525);
    anchor.appendChild(node(drawing, "xdr:ext", { cx: w, cy: h }, DRAW));
    const pic = node(drawing, "xdr:pic", {}, DRAW),
      nv = node(drawing, "xdr:nvPicPr", {}, DRAW);
    nv.appendChild(
      node(
        drawing,
        "xdr:cNvPr",
        {
          id:
            Math.max(
              0,
              ...elements(drawing, "cNvPr").map((n) =>
                Number(n.getAttribute("id")),
              ),
            ) + 1,
          name: imageName,
        },
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
    // 中文保持独立 DrawingML 文本框，随图片同比例定位，Excel/WPS 中可修改和拖动。
    for (const [index, annotation] of annotations.entries()) {
      const labelAnchor = node(drawing, "xdr:absoluteAnchor", {}, DRAW);
      labelAnchor.appendChild(
        node(
          drawing,
          "xdr:pos",
          {
            x: Math.round(
              (originX + annotation.box.x * dim.width * scale) * 9525,
            ),
            y: Math.round(
              (originY + annotation.box.y * dim.height * scale) * 9525,
            ),
          },
          DRAW,
        ),
      );
      const labelWidth = Math.round(annotation.box.width * w),
        labelHeight = Math.round(annotation.box.height * h);
      labelAnchor.appendChild(
        node(drawing, "xdr:ext", { cx: labelWidth, cy: labelHeight }, DRAW),
      );
      const sp = node(drawing, "xdr:sp", {}, DRAW),
        nonVisual = node(drawing, "xdr:nvSpPr", {}, DRAW);
      const id =
        Math.max(
          0,
          ...elements(drawing, "cNvPr").map((n) =>
            Number(n.getAttribute("id")),
          ),
        ) + 1;
      nonVisual.appendChild(
        node(
          drawing,
          "xdr:cNvPr",
          { id, name: `中文标注 ${index + 1}`, descr: annotation.textEn },
          DRAW,
        ),
      );
      nonVisual.appendChild(node(drawing, "xdr:cNvSpPr", { txBox: 1 }, DRAW));
      sp.appendChild(nonVisual);
      const properties = node(drawing, "xdr:spPr", {}, DRAW),
        transform = node(drawing, "a:xfrm", {}, A);
      transform.appendChild(node(drawing, "a:off", { x: 0, y: 0 }, A));
      transform.appendChild(
        node(drawing, "a:ext", { cx: labelWidth, cy: labelHeight }, A),
      );
      properties.appendChild(transform);
      const geometry = node(drawing, "a:prstGeom", { prst: "rect" }, A);
      geometry.appendChild(node(drawing, "a:avLst", {}, A));
      properties.appendChild(geometry);
      properties.appendChild(node(drawing, "a:noFill", {}, A));
      const line = node(drawing, "a:ln", {}, A);
      line.appendChild(node(drawing, "a:noFill", {}, A));
      properties.appendChild(line);
      sp.appendChild(properties);
      const body = node(drawing, "xdr:txBody", {}, DRAW);
      const inset = Math.round(2 * scale * 9525);
      const bodyProperties = node(
        drawing,
        "a:bodyPr",
        {
          wrap: "none",
          lIns: inset,
          rIns: inset,
          tIns: inset,
          bIns: inset,
          anchor: "t",
        },
        A,
      );
      bodyProperties.appendChild(node(drawing, "a:noAutofit", {}, A));
      body.appendChild(bodyProperties);
      body.appendChild(node(drawing, "a:lstStyle", {}, A));
      const size = Math.round(annotation.fontSize * scale * 75);
      for (const textLine of annotation.textZh.split("\n")) {
        const paragraph = node(drawing, "a:p", {}, A),
          paragraphProperties = node(drawing, "a:pPr", {}, A);
        const spacing = node(drawing, "a:lnSpc", {}, A);
        spacing.appendChild(
          node(drawing, "a:spcPts", { val: Math.round(size * 1.25) }, A),
        );
        paragraphProperties.appendChild(spacing);
        paragraph.appendChild(paragraphProperties);
        const run = node(drawing, "a:r", {}, A),
          runProperties = node(
            drawing,
            "a:rPr",
            { lang: "zh-CN", sz: size },
            A,
          );
        const fillColor = node(drawing, "a:solidFill", {}, A);
        fillColor.appendChild(node(drawing, "a:srgbClr", { val: "0000CC" }, A));
        runProperties.appendChild(fillColor);
        runProperties.appendChild(
          node(drawing, "a:latin", { typeface: "Microsoft YaHei" }, A),
        );
        runProperties.appendChild(
          node(drawing, "a:ea", { typeface: "Microsoft YaHei" }, A),
        );
        run.appendChild(runProperties);
        const text = node(drawing, "a:t", {}, A);
        text.appendChild(drawing.createTextNode(textLine));
        run.appendChild(text);
        paragraph.appendChild(run);
        paragraph.appendChild(
          node(drawing, "a:endParaRPr", { lang: "zh-CN", sz: size }, A),
        );
        body.appendChild(paragraph);
      }
      sp.appendChild(body);
      labelAnchor.appendChild(sp);
      labelAnchor.appendChild(
        node(
          drawing,
          "xdr:clientData",
          { fPrintsWithSheet: 1, fLocksWithSheet: 0 },
          DRAW,
        ),
      );
      drawing.documentElement!.appendChild(labelAnchor);
    }
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
  snapshot(): TemplateSheet {
    const merges = elements(this.doc, "mergeCell").map((m) =>
      areaCoords(m.getAttribute("ref")!),
    );
    const cells: TemplateCell[] = [];
    for (const cell of elements(this.doc, "c")) {
      const address = cell.getAttribute("r")!;
      const formula = elements(cell, "f")[0]?.textContent || "";
      const value = /DISPIMG/i.test(formula) ? formula : this.value(address);
      if (value === null || value === "") continue;
      const { row, col } = splitAddress(address);
      const merge = merges.find(
        (m) => m.start.row === row && m.start.col === col,
      );
      cells.push({ address, row, col, value, endCol: merge?.end.col ?? col });
    }
    return { name: this.name, cells };
  }
  bounds() {
    // XLS转换器会把仅有空白格式的列扩到IW；不能用dimension作为打印内容范围。
    const addresses = this.snapshot().cells.map((cell) => ({
      row: cell.row,
      col: cell.endCol,
    }));
    const contentWidth = Math.max(1, ...addresses.map((c) => c.col));
    for (const merge of elements(this.doc, "mergeCell")) {
      const area = areaCoords(merge.getAttribute("ref")!);
      // XLS 还可能带有 IV 等远端空白合并；保留它们的格式，但不把它们算入页面。
      if (area.start.col <= contentWidth) addresses.push(area.end);
    }
    return {
      row: Math.max(
        1,
        ...addresses.map((c) => c.row),
        ...children(this.data, "row")
          .filter((r) => r.hasAttribute("ht"))
          .map((r) => Number(r.getAttribute("r"))),
      ),
      col: Math.max(1, ...addresses.map((c) => c.col)),
    };
  }
  async insertRows(at: number, count: number, source: number) {
    if (count <= 0) return;
    // 共享公式先展开为逐格公式，避免插行后共享范围与复制行互相覆盖。
    const shared = new Map<string, { address: string; formula: string }>();
    for (const cell of elements(this.doc, "c")) {
      const f = first(cell, "f");
      if (f?.getAttribute("t") === "shared" && f.textContent?.trim())
        shared.set(f.getAttribute("si")!, {
          address: cell.getAttribute("r")!,
          formula: f.textContent,
        });
    }
    for (const cell of elements(this.doc, "c")) {
      const f = first(cell, "f");
      if (f?.getAttribute("t") !== "shared") continue;
      const master = shared.get(f.getAttribute("si")!);
      if (!master) continue;
      const from = splitAddress(master.address),
        to = splitAddress(cell.getAttribute("r")!);
      f.textContent = copyFormula(
        master.formula,
        to.row - from.row,
        to.col - from.col,
      );
      for (const attribute of ["t", "si", "ref"]) f.removeAttribute(attribute);
    }
    const sourceRow = this.row(source);
    for (const row of children(this.data, "row").reverse()) {
      const index = Number(row.getAttribute("r"));
      if (index < at) continue;
      row.setAttribute("r", String(index + count));
      for (const cell of children(row, "c"))
        cell.setAttribute(
          "r",
          `${colName(splitAddress(cell.getAttribute("r")!).col)}${index + count}`,
        );
    }
    for (const tag of [
      "mergeCell",
      "dimension",
      "autoFilter",
      "hyperlink",
      "conditionalFormatting",
      "dataValidation",
      "f",
    ]) {
      for (const element of elements(this.doc, tag)) {
        for (const attribute of ["ref", "sqref"]) {
          const value = element.getAttribute(attribute);
          if (value)
            element.setAttribute(attribute, moveRows(value, at, count));
        }
      }
    }
    // 保留表内公式和其他工作表对新增行下方单元格的引用。
    for (const sh of this.book.sheets) {
      for (const f of elements(sh.doc, "f")) {
        const value = f.textContent || "";
        const updated = mapFormulaReferences(value, (prefix, range) => {
          const owner = prefix
            ? prefix.slice(0, -1).replace(/^'|'$/g, "").replaceAll("''", "'")
            : sh.name;
          return (
            (prefix || "") +
            (owner === this.name ? moveRows(range, at, count) : range)
          );
        });
        if (updated !== value) {
          f.textContent = updated;
          this.book.formulaChangedSheets.add(sh.name);
        }
      }
    }
    const pattern = sourceRow.cloneNode(true) as Element;
    for (let index = at; index < at + count; index++) {
      const row = pattern.cloneNode(true) as Element;
      row.setAttribute("r", String(index));
      for (const cell of children(row, "c")) {
        cell.setAttribute(
          "r",
          `${colName(splitAddress(cell.getAttribute("r")!).col)}${index}`,
        );
        const formula = first(cell, "f");
        while (cell.firstChild) cell.removeChild(cell.firstChild);
        if (formula) {
          formula.textContent = copyFormula(
            formula.textContent || "",
            index - Number(pattern.getAttribute("r")),
            0,
          );
          if (formula.hasAttribute("ref"))
            formula.setAttribute(
              "ref",
              copyFormula(
                formula.getAttribute("ref")!,
                index - Number(pattern.getAttribute("r")),
                0,
              ),
            );
          cell.appendChild(formula);
        }
        cell.removeAttribute("t");
      }
      const next = children(this.data, "row").find(
        (r) => Number(r.getAttribute("r")) > index,
      );
      this.data.insertBefore(row, next || null);
    }
    const ref = elements(this.doc, "drawing")[0];
    if (ref) {
      const relFile = path.posix.join(
        path.posix.dirname(this.file),
        "_rels",
        path.posix.basename(this.file) + ".rels",
      );
      const rels = await this.book.xml(relFile);
      const rel = elements(rels, "Relationship").find(
        (r) => r.getAttribute("Id") === ref.getAttributeNS(OFFICE_REL, "id"),
      );
      if (rel) {
        const file = path.posix
          .resolve(
            "/" + path.posix.dirname(this.file),
            rel.getAttribute("Target")!,
          )
          .slice(1);
        const drawing = await this.book.xml(file);
        for (const endpoint of [
          ...elements(drawing, "from"),
          ...elements(drawing, "to"),
        ]) {
          const row = elements(endpoint, "row")[0];
          if (row && Number(row.textContent) >= at - 1)
            row.textContent = String(Number(row.textContent) + count);
        }
      }
    }
  }
  showColumn(index: number) {
    const column = elements(this.doc, "col").find(
      (c) =>
        Number(c.getAttribute("min")) <= index &&
        Number(c.getAttribute("max")) >= index,
    );
    if (!column || !["1", "true"].includes(column.getAttribute("hidden") || ""))
      return;
    const min = Number(column.getAttribute("min")),
      max = Number(column.getAttribute("max"));
    if (min < index) {
      const before = column.cloneNode(true) as Element;
      before.setAttribute("max", String(index - 1));
      column.parentNode!.insertBefore(before, column);
    }
    if (max > index) {
      const after = column.cloneNode(true) as Element;
      after.setAttribute("min", String(index + 1));
      column.parentNode!.insertBefore(after, column.nextSibling);
    }
    column.setAttribute("min", String(index));
    column.setAttribute("max", String(index));
    column.removeAttribute("hidden");
  }
  clearCadBorders(area: string) {
    const { start, end } = areaCoords(area);
    const styles = new Map<number, number>();
    // 旧图下的模板框线会在换图后露出；只清图片区，保留页头框线。
    for (let row = start.row; row <= end.row; row++)
      for (let col = start.col; col <= end.col; col++) {
        const address = `${colName(col)}${row}`;
        const original = this.style(address);
        if (!styles.has(original))
          styles.set(original, this.book.borderlessStyle(original));
        this.cell(address).setAttribute("s", String(styles.get(original)!));
      }
    for (const view of elements(this.doc, "sheetView"))
      view.setAttribute("showGridLines", "0");
  }
}

function moveRows(value: string, at: number, count: number) {
  return value.replace(
    /(\$?[A-Z]{1,3}\$?)(\d+)(?::(\$?[A-Z]{1,3}\$?)(\d+))?/g,
    (_, a, r, b, end) => {
      const firstRow = Number(r) >= at ? Number(r) + count : Number(r);
      if (!b) return a + firstRow;
      const lastRow = Number(end) >= at - 1 ? Number(end) + count : Number(end);
      return `${a}${firstRow}:${b}${lastRow}`;
    },
  );
}

function mapFormulaReferences(
  value: string,
  map: (prefix: string, range: string) => string,
) {
  return value
    .split(/("(?:[^"]|"")*")/)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(
            /(?<![\w!])((?:'(?:[^']|'')+'|(?:\[\d+\])?[\p{L}\w.-]+)!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)(?![\w(])/gu,
            (_match, prefix, range) => map(prefix || "", range),
          ),
    )
    .join("");
}

function copyFormula(value: string, rows: number, columns: number) {
  // 复制公式只移动相对引用；字符串中的 A1、绝对行列和外部工作簿名保留。
  return mapFormulaReferences(
    value,
    (prefix, range) =>
      prefix +
      range.replace(
        /(\$?)([A-Z]+)(\$?)(\d+)/g,
        (_match, fixedCol, col, fixedRow, row) => {
          const nextCol = colIndex(col) + (fixedCol ? 0 : columns);
          const nextRow = Number(row) + (fixedRow ? 0 : rows);
          return nextCol < 1 || nextRow < 1
            ? "#REF!"
            : `${fixedCol}${colName(nextCol)}${fixedRow}${nextRow}`;
        },
      ),
  );
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
  formulaChangedSheets = new Set<string>();
  private borderStyles = new Map<string, number>();
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
    for (const item of children(names, "definedName")) {
      const sheetId = item.getAttribute("localSheetId");
      const sheetName =
        sheetId === null || sheetId === ""
          ? undefined
          : this.sheets[Number(sheetId)]?.name;
      const handled = sheetName !== undefined && this.printAreas.has(sheetName);
      if (
        handled &&
        [
          "Print_Area",
          "_xlnm.Print_Area",
          "Print_Titles",
          "_xlnm.Print_Titles",
        ].includes(item.getAttribute("name") || "")
      )
        names.removeChild(item);
    }
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
    if (this.printAreas.size) {
      let calc = elements(workbook, "calcPr")[0];
      if (!calc) {
        calc = node(workbook, "calcPr");
        workbook.documentElement!.appendChild(calc);
      }
      calc.setAttribute("fullCalcOnLoad", "1");
      calc.setAttribute("forceFullCalc", "1");
    }
    // Empty f nodes from converted .xls files must not hide overwritten literal values.
    for (const sh of this.sheets.filter((s) => this.printAreas.has(s.name)))
      for (const formula of elements(sh.doc, "f"))
        if (!formula.textContent?.trim() && !formula.hasAttribute("t"))
          formula.parentNode!.removeChild(formula);
    const preservedFiles = new Set(
      this.sheets
        .filter(
          (s) =>
            !this.printAreas.has(s.name) &&
            !this.formulaChangedSheets.has(s.name),
        )
        .map((s) => s.file),
    );
    for (const [file, doc] of this.docs)
      if (!preservedFiles.has(file)) this.zip.file(file, serialize(doc));
    return this.zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
  }
  numberStyle(base: number, format: string) {
    const xfs = elements(this.styles, "cellXfs")[0];
    const xf = children(xfs, "xf")[base].cloneNode(true) as Element;
    let formats = elements(this.styles, "numFmts")[0];
    if (!formats) {
      formats = node(this.styles, "numFmts", { count: 0 });
      this.styles.documentElement!.insertBefore(
        formats,
        this.styles.documentElement!.firstChild,
      );
    }
    let entry = children(formats, "numFmt").find(
      (f) => f.getAttribute("formatCode") === format,
    );
    if (!entry) {
      const id =
        Math.max(
          163,
          ...children(formats, "numFmt").map((f) =>
            Number(f.getAttribute("numFmtId")),
          ),
        ) + 1;
      entry = node(this.styles, "numFmt", { numFmtId: id, formatCode: format });
      formats.appendChild(entry);
      formats.setAttribute("count", String(children(formats, "numFmt").length));
    }
    xf.setAttribute("numFmtId", entry.getAttribute("numFmtId")!);
    xf.setAttribute("applyNumberFormat", "1");
    const existing = children(xfs, "xf").findIndex(
      (item) => serializeElement(item) === serializeElement(xf),
    );
    if (existing >= 0) return existing;
    xfs.appendChild(xf);
    xfs.setAttribute("count", String(children(xfs, "xf").length));
    return children(xfs, "xf").length - 1;
  }
  graphicStyle(base: number) {
    const xfs = elements(this.styles, "cellXfs")[0];
    const xf = children(xfs, "xf")[base].cloneNode(true) as Element;
    xf.setAttribute("fillId", "0");
    xf.setAttribute("applyFill", "1");
    const existing = children(xfs, "xf").findIndex(
      (item) => serializeElement(item) === serializeElement(xf),
    );
    if (existing >= 0) return existing;
    xfs.appendChild(xf);
    xfs.setAttribute("count", String(children(xfs, "xf").length));
    return children(xfs, "xf").length - 1;
  }
  fontInfo(base: number) {
    const xf = children(elements(this.styles, "cellXfs")[0], "xf")[base];
    const font = children(elements(this.styles, "fonts")[0], "font")[
      Number(xf.getAttribute("fontId") || 0)
    ];
    return {
      size: Number(elements(font, "sz")[0]?.getAttribute("val") || 11),
      vertical: first(xf, "alignment")?.getAttribute("textRotation") === "255",
    };
  }
  wrapStyle(base: number, size?: number) {
    const xfs = elements(this.styles, "cellXfs")[0];
    const xf = children(xfs, "xf")[base].cloneNode(true) as Element;
    let alignment = first(xf, "alignment");
    if (!alignment) {
      alignment = node(this.styles, "alignment");
      xf.appendChild(alignment);
    }
    if (alignment.getAttribute("textRotation") !== "255") {
      alignment.setAttribute("wrapText", "1");
      alignment.removeAttribute("shrinkToFit");
      alignment.setAttribute("vertical", "center");
    }
    xf.setAttribute("applyAlignment", "1");
    if (size !== undefined) {
      const fonts = elements(this.styles, "fonts")[0];
      const font = children(fonts, "font")[
        Number(xf.getAttribute("fontId") || 0)
      ].cloneNode(true) as Element;
      elements(font, "sz")[0].setAttribute(
        "val",
        String(Math.round(size * 10) / 10),
      );
      let id = children(fonts, "font").findIndex(
        (f) => serializeElement(f) === serializeElement(font),
      );
      if (id < 0) {
        id = children(fonts, "font").length;
        fonts.appendChild(font);
        fonts.setAttribute("count", String(id + 1));
      }
      xf.setAttribute("fontId", String(id));
      xf.setAttribute("applyFont", "1");
    }
    const existing = children(xfs, "xf").findIndex(
      (item) => serializeElement(item) === serializeElement(xf),
    );
    if (existing >= 0) return existing;
    xfs.appendChild(xf);
    xfs.setAttribute("count", String(children(xfs, "xf").length));
    return children(xfs, "xf").length - 1;
  }
  preserveBorder(base: number, original: number) {
    const xfs = elements(this.styles, "cellXfs")[0];
    const source = children(xfs, "xf")[base];
    const target = children(xfs, "xf")[original];
    const border = target.getAttribute("borderId") || "0";
    const apply = target.getAttribute("applyBorder");
    if (
      (source.getAttribute("borderId") || "0") === border &&
      source.getAttribute("applyBorder") === apply
    )
      return base;
    const key = `${base}:${border}:${apply}`;
    const cached = this.borderStyles.get(key);
    if (cached !== undefined) return cached;
    // 字体、换行等可随内容适配；框线始终来自目标格，不能从别的表复制。
    const xf = source.cloneNode(true) as Element;
    xf.setAttribute("borderId", border);
    if (apply !== null) xf.setAttribute("applyBorder", apply);
    else xf.removeAttribute("applyBorder");
    const index = children(xfs, "xf").length;
    xfs.appendChild(xf);
    xfs.setAttribute("count", String(index + 1));
    this.borderStyles.set(key, index);
    return index;
  }
  borderlessStyle(base: number) {
    const xfs = elements(this.styles, "cellXfs")[0];
    const xf = children(xfs, "xf")[base].cloneNode(true) as Element;
    xf.setAttribute("borderId", "0");
    xf.setAttribute("applyBorder", "1");
    const existing = children(xfs, "xf").findIndex(
      (item) => serializeElement(item) === serializeElement(xf),
    );
    if (existing >= 0) return existing;
    const index = children(xfs, "xf").length;
    xfs.appendChild(xf);
    xfs.setAttribute("count", String(index + 1));
    return index;
  }
}

const serializeElement = (element: Element) =>
  new XMLSerializer().serializeToString(element);

export async function inspectTemplate(bytes: Buffer) {
  const book = new TemplateBook(await JSZip.loadAsync(bytes));
  await book.initialize();
  return book.sheets.map((s) => s.name);
}
function materialValues(m: Material): (string | number | null)[] {
  const extra = m.colors
    .slice(2)
    .map((color, i) => `配色${i + 3}：${chineseColor(color)}`)
    .join("\n");
  return [
    chinese(m.nameZh),
    chinese(m.specZh),
    m.colors[0] ? chineseColor(m.colors[0]) : CHINESE_TBC,
    m.colors[1] ? chineseColor(m.colors[1]) : null,
    m.quantity,
    chinese(m.unitZh),
    chinese(m.placementZh),
    [m.notesZh ? chinese(m.notesZh) : null, extra].filter(Boolean).join("\n") ||
      null,
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

function localizeSheetLabels(sh: Sheet, role: ReturnType<typeof templateRole>) {
  if (["cad", "measurements", "mail", "unknown"].includes(role)) return;
  const snapshot = sh.snapshot();
  const protectedAfter =
    role === "sample" ? sampleTotalRow(snapshot) : undefined;
  const headers = new Map<string, string>(
    templateTables(snapshot, role).flatMap((table) =>
      table.columns.map(
        (column) =>
          [`${colName(column.col)}${table.row}`, column.field] as const,
      ),
    ),
  );
  for (const cell of snapshot.cells) {
    if (
      typeof cell.value !== "string" ||
      (protectedAfter !== undefined && cell.row > protectedAfter) ||
      cell.value.startsWith("风险评估会意见：")
    )
      continue;
    let value = cell.value
      .replaceAll("待确认 / TBC", TBC)
      .replace(/\bTBC\b/g, TBC);
    if (
      cell.row <= 2 ||
      headers.has(cell.address) ||
      scalarField(cell.value) ||
      /所需信息|SWATCHINFORMATION|^(配色|COLORWAY|总计|合计|TOTAL)/.test(
        normalizeLabel(cell.value),
      )
    )
      value = chineseLabel(value, headers.get(cell.address));
    if (value !== cell.value) sh.set(cell.address, value);
  }
}

export async function generateWorkbook(
  template: Buffer,
  data: TechPack,
  figures: FigureImage[] = [],
) {
  const book = new TemplateBook(await JSZip.loadAsync(template));
  await book.initialize();
  const meta = data.meta,
    style = [meta.styleNumber, meta.styleName].filter(Boolean).join(" ") || TBC;
  const description = chinese(meta.descriptionZh),
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
    B33: "客户",
    B34: "订单号",
    B35: "款号",
    B36: "款式",
    B37: "跟单",
    B38: "经理审核",
    B39: "发单日期",
  }))
    cover.set(cell, value, coverStyle);
  for (let r = 33; r <= 39; r++) cover.height(r, r === 36 ? 64 : 40);
  cover.merged(
    "F2:G2",
    "版师：待确认",
    25,
    book.style(coverStyle, { size: 10 }),
  );
  if (figure("appearance")[0])
    await cover.picture(figure("appearance")[0].data, "F5", 120, 300);
  sheets.push(cover.print("A1:G39"));

  // 总计下方的客户说明保留原文、合并、样式和行高，旧款图片继续清除。
  await sample.drawing(false, true);
  sample.clear("A3:J9");
  const small = book.style(sample.style("A3"), { size: 12 });
  for (const [cell, value] of Object.entries({
    A2: "数量搭配及打样要求",
    A3: "订单号",
    B3: meta.orderNumber || TBC,
    D3: "工厂",
    F3: meta.factory || TBC,
    G3: "样衣数量",
    I3: meta.sampleQuantity ?? TBC,
    A4: "款号",
    B4: style,
    D4: "属性",
    F4: "开发",
    G4: "样品交期",
    I4: meta.dueDate || TBC,
    A5: "品名",
    B5: description,
    D5: "跟单",
    F5: meta.merchandiser || TBC,
    G5: "发单日期",
    I5: meta.issueDate || TBC,
  }))
    sample.set(cell, value, small);
  sample.height(3, 42);
  sample.height(4, 42);
  sample.height(5, 80);
  sample.height(6, 40);
  sample.height(7, 62);
  sample.set("A6", "配色", small);
  meta.sizeScale
    .slice(0, 7)
    .forEach((s, i) => sample.set(`${colName(i + 2)}6`, s, small));
  sample.set("I6", "总计", small);
  sample.set(
    "A7",
    chineseColor(materials.find((m) => m.kind === "fabric")?.colors[0] || ""),
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
  sample.set("A9", "总计", small);
  sample.set("I9", meta.sampleQuantity ?? TBC, small);
  sheets.push(sample.print(`A1:J${Math.max(13, sample.bounds().row)}`));

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
    sh.clearCadBorders(`A4:H${Math.max(150, sh.bounds().row)}`);
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
        image.annotations,
      );
    }
    if (!selected.length)
      sh.set("A4", "未提供对应图片 / SOURCE IMAGE NOT PROVIDED", regular);
    // CAD 译文只使用图上的可编辑标注，不再补写图下说明。
    const lastRow = selected.length > 2 ? 14 + (selected.length - 1) * 5 : 15;
    sheets.push(sh.print(`A1:H${lastRow}`));
  }

  await bom.drawing();
  bom.unmerge("A5:H200");
  bom.clear("A5:H200");
  bom.set("A1", `${style} 面辅料搭配表`);
  for (const [cell, value] of Object.entries({
    A2: "订单号",
    B2: meta.orderNumber || TBC,
    A3: "款号",
    B3: style,
    A4: "品名",
    B4: description,
    E2: "客户",
    G2: [meta.brand, meta.customer].filter(Boolean).join(" / ") || TBC,
    E3: "跟单",
    G3: meta.merchandiser || TBC,
    E4: "资料日期",
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
    "面料名称",
    "规格",
    "配色1",
    "配色2",
    "数量",
    "单位",
    "部位",
    "备注",
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
    .map((h, i) => (i === 0 ? "辅料名称" : h))
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
    "空白数量表示资料未提供；不是零用量。",
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
  for (const [i, v] of ["名称", "规格", "部位", "备注"].entries())
    risk.set(`${colName(i + 4)}6`, v, label);
  risk.height(6, 30);
  for (const [i, m] of fabrics.entries()) {
    const row = i + 7;
    const values = [
      chinese(m.nameZh),
      chinese(m.specZh),
      chinese(m.placementZh),
      m.colors.map(chineseColor).join("\n") || TBC,
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
    "签字：__________________    日期：__________________",
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
  cons.set("A1", "武汉多恩投资有限公司耗料申请单");
  cons.set("B3", "订单：", compact);
  cons.set("B4", "款号：", compact);
  cons.set("H3", "日期：", compact);
  cons.set("D3", meta.orderNumber || TBC, compact);
  cons.set("I3", meta.issueDate || TBC, compact);
  cons.set("C4", style, compact);
  cons.set("H4", "耗料师：待确认", compact);
  cons.height(3, 32);
  cons.height(4, 32);
  const consHeaders = [
    "款号",
    "图",
    "类别",
    "数量",
    "物料",
    "部位",
    "净幅宽",
    "经缩",
    "纬缩",
    "净耗",
    "损耗",
    "报价耗料",
  ];
  consHeaders.forEach((v, i) => cons.set(`${colName(i + 1)}5`, v, compact));
  cons.height(5, 48);
  fabrics.forEach((m, i) => {
    const row = i + 6;
    const values = [
      style,
      i === 0 ? "" : "见封面",
      "开发",
      meta.sampleQuantity ?? TBC,
      chinese(m.nameZh) +
        "\n" +
        chinese(m.specZh) +
        "\n" +
        (m.colors[0] ? chineseColor(m.colors[0]) : TBC),
      chinese(m.placementZh),
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
    "幅宽、缩水率、单耗和损耗率须测试/核算，不沿用旧款数值。",
    40,
    compact,
  );
  cons.merged(
    `A${consLast + 1}:L${consLast + 1}`,
    `制单：${meta.merchandiser || TBC}`,
    30,
    compact,
  );
  sheets.push(cons.print(`A1:L${consLast + 1}`));

  await card.drawing();
  clearSwatchBody(card);
  card.set("A2", "样衣面料留底卡");
  for (const [cell, value] of Object.entries({
    A3: "客户",
    C3: "款号",
    E3: "款式",
    G3: "跟单",
    I3: "日期",
  }))
    card.set(cell, value, label);
  for (const [cell, value] of Object.entries({
    B3: [meta.brand, meta.customer].filter(Boolean).join(" / ") || TBC,
    D3: style,
    F3: description,
    H3: meta.merchandiser || TBC,
    J3: meta.issueDate || TBC,
    L1: [meta.brand, meta.customer].filter(Boolean).join(" / ") || TBC,
    L12: style,
    L40: meta.descriptionZh || TBC,
    L55: meta.merchandiser || TBC,
  }))
    writeTemplateCell(
      book,
      card,
      cell,
      value,
      cell.startsWith("L") ? undefined : label,
    );
  card.height(3, fittedHeight([description], [card.width(6)], 11, 54));
  sheets.push(card.print(`A1:M${card.bounds().row}`));
  // Clear previous style identifiers only in editable metadata; original mail stays untouched.
  const warnings = [
    ...missingSummary(data),
    ...annotationWarnings(figures),
    ...chineseExportWarnings(data),
  ];
  for (const sh of book.sheets)
    localizeSheetLabels(sh, templateRole(sh.snapshot()));
  return {
    buffer: await book.finish(),
    sheets: book.sheets
      .map((s) => sheets.find((p) => p.name === s.name)!)
      .filter(Boolean),
    warnings,
  };
}

function templateMeta(
  data: TechPack,
  dualLanguage: boolean,
): Record<string, string | number | null> {
  const { sizeScale, ...meta } = data.meta;
  return {
    ...meta,
    description: dualLanguage
      ? bilingual(data.meta.descriptionZh, data.meta.descriptionEn)
      : chinese(data.meta.descriptionZh),
    customer:
      [data.meta.brand, data.meta.customer].filter(Boolean).join(" / ") || TBC,
    unit: dualLanguage
      ? data.meta.unit === "inch"
        ? "英寸 / INCH"
        : "厘米 / CM"
      : data.meta.unit === "inch"
        ? "英寸"
        : "厘米",
    clear: TBC,
  };
}

function writeTemplateCell(
  book: TemplateBook,
  sh: Sheet,
  address: string,
  value: string | number | null,
  style?: number,
) {
  // 横向字段沿用原字号并扩行；固定竖排侧栏按其合并区域的高度适配字号。
  const pos = splitAddress(address);
  let base = style ?? sh.style(address);
  const info = book.fontInfo(base);
  const merge = elements(sh.doc, "mergeCell")
    .map((m) => areaCoords(m.getAttribute("ref")!))
    .find((m) => m.start.row === pos.row && m.start.col === pos.col);
  const lastCol = merge?.end.col ?? pos.col;
  let fontSize: number | undefined;
  if (info.vertical && value !== null) {
    const height = Array.from(
      { length: (merge?.end.row ?? pos.row) - pos.row + 1 },
      (_, i) => Number(sh.row(pos.row + i).getAttribute("ht") || 15),
    ).reduce((a, b) => a + b, 0);
    fontSize = Math.min(
      info.size,
      Math.max(
        1,
        (height - 8) /
          Math.max(1, String(value).replace(/\s/g, "").length) /
          1.1,
      ),
    );
  }
  base = book.wrapStyle(base, fontSize);
  sh.set(address, value, base);
  if (value === null || info.vertical || (merge && merge.end.row > pos.row))
    return;
  const width = Array.from({ length: lastCol - pos.col + 1 }, (_, i) =>
    sh.width(pos.col + i),
  ).reduce((a, b) => a + b, 0);
  if (width > 0)
    sh.height(
      pos.row,
      Math.max(
        Number(sh.row(pos.row).getAttribute("ht") || 15),
        fittedHeight([value], [width], info.size, 20),
      ),
    );
}

function fillTemplateMeta(
  book: TemplateBook,
  sh: Sheet,
  data: TechPack,
  endRow: number,
  warnings: string[],
  extraRows: Set<number> = new Set(),
  protectedAfter = Infinity,
) {
  const snapshot = sh.snapshot();
  snapshot.cells = snapshot.cells.filter((cell) => cell.row <= protectedAfter);
  const values = templateMeta(
    data,
    ["cad", "measurements"].includes(templateRole(sh.snapshot())),
  );
  const claimed = new Set<string>();
  const replacements = new Map<
    string,
    { field: string; value: string | number }
  >();
  const bounds = sh.bounds();
  for (const cell of snapshot.cells.filter(
    (c) =>
      c.row <= endRow ||
      extraRows.has(c.row) ||
      /^(制单人|PREPARED BY)/i.test(String(c.value).trim()),
  )) {
    const field = scalarField(cell.value);
    if (!field) continue;
    claimed.add(cell.address);
    const value = values[field] ?? TBC;
    const inline = String(cell.value).match(/^(.*?[：:])\s*(.+)$/s);
    if (inline && inline[2].trim() && scalarField(inline[1])) {
      writeTemplateCell(book, sh, cell.address, inline[1] + value);
      continue;
    }
    const right = `${colName(cell.endCol + 1)}${cell.row}`;
    const neighbor = snapshot.cells.find((c) => c.address === right);
    const below = `${colName(cell.col)}${cell.row + 1}`;
    let address =
      cell.endCol < bounds.col && !scalarField(neighbor?.value) ? right : below;
    const semanticValue = snapshot.cells.filter(
      (c) =>
        !claimed.has(c.address) &&
        (c.row === cell.row || c.row === cell.row + 1) &&
        (field === "unit"
          ? /^(英寸|厘米|INCH|CM)$/i.test(String(c.value).trim())
          : field === "styleNumber" &&
            /^(?:S\d{6}[-－])?[A-Z]+[-]?\d{3,}/i.test(String(c.value).trim())),
    );
    if (semanticValue.length === 1) address = semanticValue[0].address;
    if (scalarField(sh.value(address))) {
      warnings.push(
        `「${sh.name}」${cell.address} 的填写位置未能确定，保留该栏目。`,
      );
      continue;
    }
    const previous = sh.value(address);
    if (
      typeof previous === "string" &&
      previous.trim().length >= 3 &&
      previous !== TBC
    )
      replacements.set(previous, { field, value });
    writeTemplateCell(book, sh, address, value);
    claimed.add(address);
  }
  // 同一款号/款名可能出现在留卡的竖排侧栏，随已确认的字段一起更新。
  for (const cell of snapshot.cells) {
    const replacement =
      typeof cell.value === "string" ? replacements.get(cell.value) : undefined;
    if (replacement !== undefined) {
      let value = replacement.value;
      if (book.fontInfo(sh.style(cell.address)).vertical) {
        if (replacement.field === "description")
          value = chinese(data.meta.descriptionZh);
        if (replacement.field === "customer")
          value = data.meta.brand || data.meta.customer || TBC;
      }
      writeTemplateCell(book, sh, cell.address, value);
      claimed.add(cell.address);
    }
  }
  for (const cell of snapshot.cells.filter(
    (c) => (c.row <= endRow || extraRows.has(c.row)) && !claimed.has(c.address),
  )) {
    const text = String(cell.value).trim();
    if (/DISPIMG/i.test(text)) {
      sh.set(cell.address, null);
      continue;
    }
    if (
      templateRole(snapshot) === "measurements" &&
      /^(XXS|XS|S|M|L|XL|XXL|XXXL|[2-8]XL)$/.test(text)
    ) {
      writeTemplateCell(book, sh, cell.address, data.meta.sampleSize || TBC);
      continue;
    }
    if (
      /[：:]$/.test(text) ||
      (text.length > 18 && cell.endCol > cell.col) ||
      /公司|COMPANY|CORPORATION|表|图|留卡|留底卡|要求|所需|说明|信息|配色|尺寸|单位|批次|头样|开发|数量|SAMPLE|COLORWAY|MEASUREMENT/i.test(
        text,
      )
    )
      continue;
    writeTemplateCell(book, sh, cell.address, TBC);
    warnings.push(
      `「${sh.name}」${cell.address} 原值没有明确字段标签，已置为待确认。`,
    );
  }
}

function templateRowValues(
  data: TechPack,
  item: Material | TechPack["measurements"][number],
): Record<string, string | number | null> {
  if ("kind" in item) {
    const colors = Object.fromEntries(
      item.colors.map((color, i) => [`color${i + 1}`, chineseColor(color)]),
    );
    return {
      ...colors,
      name: chinese(item.nameZh),
      spec: chinese(item.specZh),
      quantity: item.quantity,
      sampleQuantity: data.meta.sampleQuantity ?? TBC,
      // 构件单耗和样衣数量都不能当作大货产量，现有资料未提供时留待确认。
      productionQuantity: TBC,
      unit: chinese(item.unitZh),
      placement: chinese(item.placementZh),
      notes: item.notesZh ? chinese(item.notesZh) : null,
      style: data.meta.styleNumber || TBC,
      stage: "开发",
      width: TBC,
      warp: TBC,
      weft: TBC,
      net: TBC,
      waste: TBC,
      quote: TBC,
      image: null,
      clear: null,
    };
  }
  return {
    nameEn: item.nameEn || TBC,
    nameZh: item.nameZh || TBC,
    value: item.value ?? item.sourceValue ?? TBC,
    tolerance: item.tolerance,
    clear: null,
  };
}

async function fillTemplateTable(
  book: TemplateBook,
  sh: Sheet,
  table: TemplateTable,
  data: TechPack,
  records: (Material | TechPack["measurements"][number])[],
  stop: number | undefined,
) {
  const firstRow = table.row + 1;
  // 原表头也按其字号换行，避免扩行后的单页打印遮住多行栏目名称。
  for (const column of table.columns) {
    const address = `${colName(column.col)}${table.row}`;
    writeTemplateCell(book, sh, address, sh.value(address));
  }
  const left = Math.min(...table.columns.map((c) => c.col));
  const right = Math.max(...table.columns.map((c) => c.endCol));
  const allCells = sh.snapshot().cells;
  const consumption = templateRole(sh.snapshot()) === "consumption";
  const source = allCells.filter(
    (c) => c.row >= firstRow && c.col >= left && c.col <= right,
  );
  const footer = allCells
    .filter((c) => c.row >= firstRow && (!stop || c.row < stop))
    .find((c) =>
      /^(总计|合计|制单人|风险评估会意见|签字|空白数量)/.test(
        String(c.value).trim(),
      ),
    );
  const lastValue = Math.max(
    firstRow,
    ...source.filter((c) => !stop || c.row < stop).map((c) => c.row),
  );
  const boundary = Math.min(stop ?? Infinity, footer?.row ?? Infinity);
  let lastRow = Number.isFinite(boundary) ? boundary - 1 : lastValue;
  lastRow = Math.max(firstRow, lastRow);
  const extra = Math.max(0, records.length - (lastRow - firstRow + 1));
  await sh.insertRows(lastRow + 1, extra, firstRow);
  lastRow += extra;
  sh.unmerge(`${colName(left)}${firstRow}:${colName(right)}${lastRow}`);
  sh.clear(`${colName(left)}${firstRow}:${colName(right)}${lastRow}`);
  for (const [index, item] of records.entries()) {
    const row = firstRow + index;
    const values = templateRowValues(data, item);
    if (consumption && "kind" in item)
      values.name = [
        chinese(item.nameZh),
        chinese(item.specZh),
        item.colors.map(chineseColor).join(" / ") || TBC,
      ].join("\n");
    if (!("kind" in item)) {
      if (!table.columns.some((c) => c.field === "nameZh"))
        values.nameEn = bilingual(item.nameZh, item.nameEn);
      if (!table.columns.some((c) => c.field === "nameEn"))
        values.nameZh = bilingual(item.nameZh, item.nameEn);
    }
    sh.height(row, 30);
    for (const column of table.columns) {
      const address = `${colName(column.col)}${row}`;
      if (column.endCol > column.col)
        sh.merge(`${address}:${colName(column.endCol)}${row}`);
      const value =
        values[column.field] ??
        (column.field === "clear" ||
        column.field === "image" ||
        column.field === "quantity" ||
        column.field === "notes" ||
        /^color[2-9]/.test(column.field)
          ? null
          : TBC);
      const graphic = "kind" in item && item.kind === "graphic";
      const base = graphic
        ? book.graphicStyle(sh.style(address))
        : sh.style(address);
      const style =
        typeof value === "number"
          ? book.numberStyle(
              base,
              column.field === "value" || column.field === "tolerance"
                ? data.meta.unit === "inch"
                  ? "# ?/?"
                  : "0.##"
                : "0.##",
            )
          : graphic
            ? base
            : undefined;
      if (value !== null) sh.showColumn(column.col);
      writeTemplateCell(book, sh, address, value, style);
    }
  }
}

async function fillSampleGrid(book: TemplateBook, sh: Sheet, data: TechPack) {
  const snapshot = sh.snapshot();
  const color = snapshot.cells.find((c) =>
    /配色|COLORWAY/.test(normalizeLabel(c.value)),
  );
  if (!color) return;
  const headers = snapshot.cells.filter(
    (c) =>
      c.row === color.row &&
      /^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-8]XL)$/.test(String(c.value).trim()),
  );
  if (!headers.length) return;
  const total = snapshot.cells.find(
    (c) => c.row === color.row && /总计|TOTAL/.test(normalizeLabel(c.value)),
  );
  const footerRow = sampleTotalRow(snapshot);
  const footer = snapshot.cells.find(
    (c) =>
      c.row === footerRow && /总计|合计|TOTAL/.test(normalizeLabel(c.value)),
  );
  const colors =
    normalizedMaterials(data).find((m) => m.kind === "fabric")?.colors || [];
  const records = colors.length ? colors.map(chineseColor) : [TBC];
  const end = footer ? footer.row - 1 : color.row + records.length;
  const extra = Math.max(0, records.length - (end - color.row));
  await sh.insertRows(end + 1, extra, color.row + 1);
  for (let row = color.row + 1; row <= end + extra; row++) {
    sh.set(`${colName(color.col)}${row}`, null);
    for (const header of headers) sh.set(`${colName(header.col)}${row}`, null);
    if (total) sh.set(`${colName(total.col)}${row}`, null);
  }
  records.forEach((value, index) => {
    const row = color.row + 1 + index;
    writeTemplateCell(book, sh, `${colName(color.col)}${row}`, value);
    for (const header of headers)
      writeTemplateCell(
        book,
        sh,
        `${colName(header.col)}${row}`,
        String(header.value).trim() === data.meta.sampleSize &&
          records.length === 1
          ? (data.meta.sampleQuantity ?? TBC)
          : TBC,
      );
    if (total)
      writeTemplateCell(
        book,
        sh,
        `${colName(total.col)}${row}`,
        records.length === 1 ? (data.meta.sampleQuantity ?? TBC) : TBC,
      );
  });
  if (footer && total)
    writeTemplateCell(
      book,
      sh,
      `${colName(total.col)}${footer.row + extra}`,
      data.meta.sampleQuantity ?? TBC,
    );
  // 总计下方的说明随新增配色整行下移，不重写客户条款。
}

function clearSwatchBody(sh: Sheet) {
  const instruction = sh
    .snapshot()
    .cells.find((c) =>
      /所需信息|SWATCHINFORMATION/.test(normalizeLabel(c.value)),
    );
  if (!instruction) return;
  // 留底卡正文留给实际贴样与手工填写，不重建面料说明、合并区域或框线。
  sh.clear(
    `${colName(instruction.col)}${instruction.row + 1}:${colName(instruction.endCol)}${sh.bounds().row}`,
  );
}

export async function generateTemplateWorkbook(
  template: Buffer,
  data: TechPack,
  figures: FigureImage[] = [],
) {
  const book = new TemplateBook(await JSZip.loadAsync(template));
  await book.initialize();
  const warnings = [
    ...missingSummary(data),
    ...annotationWarnings(figures),
    ...chineseExportWarnings(data),
  ];
  const result: {
    name: string;
    area: string;
    orientation: string;
    matched: boolean;
  }[] = [];
  const cadSheets = book.sheets.filter(
    (sh) => templateRole(sh.snapshot()) === "cad",
  );
  const materials = normalizedMaterials(data);
  const fabrics = materials.filter(
    (m) => m.kind === "fabric" || m.kind === "interlining",
  );
  const cadPurpose = new Map(
    cadSheets.map((sh) => {
      const text = normalizeLabel(
        sh.name +
          " " +
          sh
            .snapshot()
            .cells.filter((c) =>
              /^(唛头|辅料|款式参考|款式图|LABEL|TRIM|INSPIRATION|APPEARANCE)/i.test(
                String(c.value),
              ),
            )
            .map((c) => c.value)
            .join(" "),
      );
      const purpose = /唛头|LABEL/.test(text)
        ? "labels"
        : /辅料|TRIM/.test(text)
          ? "trimReference"
          : /款式参考|INSPIRATION/.test(text)
            ? "inspiration"
            : /款式图|APPEARANCE/.test(text)
              ? "appearance"
              : "general";
      return [sh, purpose];
    }),
  );
  const generalCad = cadSheets.filter((sh) => cadPurpose.get(sh) === "general");
  const cadImages = new Map(cadSheets.map((sh) => [sh, [] as FigureImage[]]));
  const hasOtherAppearanceSlot = book.sheets.some((sh) =>
    ["cover", "materials", "risk", "consumption"].includes(
      templateRole(sh.snapshot()),
    ),
  );
  const available = figures.filter(
    (image) =>
      image.role !== "appearance" ||
      !hasOtherAppearanceSlot ||
      !figures.some((f) => f.role === "construction") ||
      cadSheets.some((sh) => cadPurpose.get(sh) === "appearance"),
  );
  for (const image of available) {
    const specialized = cadSheets.filter(
      (sh) => cadPurpose.get(sh) === image.role,
    );
    const targets = specialized.length ? specialized : generalCad;
    const target = [...targets].sort(
      (a, b) => cadImages.get(a)!.length - cadImages.get(b)!.length,
    )[0];
    if (target) cadImages.get(target)!.push(image);
  }
  for (const sh of book.sheets) {
    const snapshot = sh.snapshot();
    const role = templateRole(snapshot);
    let protectedAfter =
      role === "sample" ? sampleTotalRow(snapshot) : undefined;
    const protectedRow = (row: number) =>
      protectedAfter !== undefined && row > protectedAfter;
    const tables = templateTables(snapshot, role);
    const instructions = snapshot.cells.find((c) =>
      /所需信息|SWATCHINFORMATION/.test(normalizeLabel(c.value)),
    );
    const unresolved =
      role === "unknown" ||
      (["materials", "measurements", "risk", "consumption"].includes(role) &&
        !tables.length) ||
      (role === "swatches" && !instructions) ||
      (role === "cover" && !snapshot.cells.some((c) => scalarField(c.value)));
    if (unresolved) {
      result.push({
        name: sh.name,
        area: "",
        orientation: "portrait",
        matched: false,
      });
      warnings.push(
        `「${sh.name}」未识别到明确的制单栏目，保留原表内容和打印设置，未自动填充。`,
      );
      continue;
    }
    if (role === "mail") {
      const bounds = sh.bounds();
      result.push({
        ...sh.print(`A1:${colName(bounds.col)}${bounds.row}`),
        matched: true,
      });
      continue;
    }
    for (const cell of snapshot.cells) {
      if (protectedRow(cell.row)) continue;
      if (/^#(?:VALUE!|NAME\?|REF!|DIV\/0!|N\/A)$/.test(String(cell.value))) {
        sh.set(cell.address, null);
        warnings.push(
          `「${sh.name}」${cell.address} 的原图片或公式未能读取，已清除旧错误，请核对该位置。`,
        );
      }
    }
    const firstTable = tables[0]?.row;
    const sampleHeader =
      role === "sample"
        ? snapshot.cells.find((c) =>
            /配色|COLORWAY/.test(normalizeLabel(c.value)),
          )
        : undefined;
    const metaEnd = firstTable
      ? firstTable - 1
      : sampleHeader
        ? sampleHeader.row - 1
        : instructions
          ? instructions.row - 1
          : role === "cad"
            ? Math.max(
                ...snapshot.cells
                  .filter((c) => scalarField(c.value))
                  .map((c) => c.row),
                3,
              )
            : sh.bounds().row;
    const extraMetaRows = new Set<number>();
    for (let index = 1; index < tables.length; index++) {
      const footer = snapshot.cells
        .filter(
          (c) =>
            c.row > tables[index - 1].row &&
            c.row < tables[index].row &&
            /^(制单人|总计|签字)/.test(String(c.value).trim()),
        )
        .sort((a, b) => b.row - a.row)[0];
      if (footer)
        for (let row = footer.row; row < tables[index].row; row++)
          extraMetaRows.add(row);
    }
    fillTemplateMeta(
      book,
      sh,
      data,
      metaEnd,
      warnings,
      extraMetaRows,
      protectedAfter,
    );
    for (const cell of sh.snapshot().cells)
      if (
        !protectedRow(cell.row) &&
        cell.row > 1 &&
        /DISPIMG/.test(String(cell.value))
      )
        sh.set(cell.address, null);
    const oldPictures = await sh.drawing(
      false,
      role === "cover" || role === "sample",
    );
    if (tables.length) {
      // 先填写下方表格，再扩展上方材料行，后续区域随整行一起移动。
      for (let index = tables.length - 1; index >= 0; index--) {
        const table = tables[index];
        const records =
          role === "measurements"
            ? data.measurements
            : role === "risk" || role === "consumption"
              ? fabrics
              : table.group === "trim"
                ? materials.filter(
                    (m) => m.kind === "trim" || m.kind === "label",
                  )
                : tables.length > 1
                  ? materials.filter((m) =>
                      ["fabric", "interlining", "graphic"].includes(m.kind),
                    )
                  : materials;
        await fillTemplateTable(
          book,
          sh,
          table,
          data,
          records,
          tables[index + 1]?.row,
        );
      }
      if (role === "measurements") {
        for (const column of tables[0].columns.filter(
          (c) => c.field === "value",
        ))
          sh.set(
            `${colName(column.col)}${tables[0].row}`,
            data.meta.sampleSize || "样码 / SIZE",
          );
      }
    } else if (role === "sample") {
      await fillSampleGrid(book, sh, data);
      protectedAfter = sampleTotalRow(sh.snapshot());
    } else if (role === "swatches") {
      clearSwatchBody(sh);
    } else if (role === "cad") {
      const title = snapshot.cells.find((c) =>
        /款式工艺图|CONSTRUCTION|REFERENCES|参考/.test(normalizeLabel(c.value)),
      );
      const firstRow = Math.max((title?.row || 2) + 2, metaEnd + 1);
      const bounds = sh.bounds();
      const firstCol = title?.col || 1;
      const lastCol = Math.max(firstCol, bounds.col);
      const width = Array.from({ length: lastCol - firstCol + 1 }, (_, i) =>
        sh.width(firstCol + i),
      ).reduce((a, b) => a + b, 0);
      sh.unmerge(
        `${colName(firstCol)}${firstRow}:${colName(lastCol)}${bounds.row}`,
      );
      sh.clear(
        `${colName(firstCol)}${firstRow}:${colName(lastCol)}${bounds.row}`,
      );
      const selected = cadImages.get(sh) || [];
      let row = firstRow;
      if (!selected.length) {
        sh.merged(
          `${colName(firstCol)}${row}:${colName(lastCol)}${row}`,
          "原 PDF 未提供对应图片 / SOURCE IMAGE NOT PROVIDED",
          42,
        );
        row++;
      }
      for (const image of selected) {
        for (let r = row; r < row + 10; r++) sh.height(r, 30);
        await sh.picture(
          image.data,
          `${colName(firstCol)}${row}`,
          width - 12,
          380,
          image.annotations,
        );
        row += 10;
        if (image.caption) {
          sh.merge(`${colName(firstCol)}${row}:${colName(lastCol)}${row}`);
          writeTemplateCell(
            book,
            sh,
            `${colName(firstCol)}${row}`,
            image.caption,
          );
          row++;
        }
      }
      sh.clearCadBorders(
        `${colName(firstCol)}${firstRow}:${colName(lastCol)}${Math.max(bounds.row, row)}`,
      );
    }
    if (role === "risk") {
      for (const cell of sh
        .snapshot()
        .cells.filter((c) => String(c.value).startsWith("风险评估会意见：")))
        writeTemplateCell(book, sh, cell.address, cell.value);
    }
    if (
      role !== "cad" &&
      role !== "swatches" &&
      figures.find((f) => f.role === "appearance")
    ) {
      const image = figures.find((f) => f.role === "appearance")!;
      if (role === "consumption") {
        for (const table of templateTables(sh.snapshot(), role)) {
          const column = table.columns.find((c) => c.field === "image");
          if (column)
            await sh.picture(
              image.data,
              `${colName(column.col)}${table.row + 1}`,
              Math.max(20, sh.width(column.col) - 8),
              140,
            );
        }
      }
      const pictureCell = snapshot.cells.find((c) =>
        /DISPIMG/i.test(String(c.value)),
      );
      const originalSlot = oldPictures.find(
        (p) =>
          p.row > 1 &&
          (role === "cover" ||
            (role === "materials" &&
              firstTable !== undefined &&
              p.row < firstTable) ||
            (role === "risk" &&
              p.col <
                Math.min(
                  ...tables.flatMap((t) => t.columns.map((c) => c.col)),
                ))),
      );
      const mergedSlot = elements(sh.doc, "mergeCell")
        .map((m) => areaCoords(m.getAttribute("ref")!))
        .find(
          (m) =>
            m.end.row - m.start.row >= 3 &&
            m.start.row > 1 &&
            !sh.value(`${colName(m.start.col)}${m.start.row}`) &&
            (role === "cover"
              ? m.start.col >
                Math.min(
                  ...snapshot.cells
                    .filter((c) => scalarField(c.value))
                    .map((c) => c.col),
                )
              : role === "materials"
                ? firstTable !== undefined && m.end.row < firstTable
                : role === "risk" &&
                  m.end.col <
                    Math.min(
                      ...tables.flatMap((t) => t.columns.map((c) => c.col)),
                    )),
        );
      const imageColumn = tables[0]?.columns.find((c) => c.field === "image");
      const address =
        pictureCell?.address ||
        originalSlot?.address ||
        (mergedSlot
          ? `${colName(mergedSlot.start.col)}${mergedSlot.start.row}`
          : role === "consumption" && imageColumn
            ? `${colName(imageColumn.col)}${tables[0].row + 1}`
            : undefined);
      if (address && role !== "consumption") {
        const position = splitAddress(address);
        const availableHeight =
          role === "materials" && firstTable
            ? Array.from(
                { length: Math.max(1, firstTable - position.row) },
                (_, i) =>
                  (Number(sh.row(position.row + i).getAttribute("ht") || 15) *
                    4) /
                  3,
              ).reduce((a, b) => a + b, 0) - 8
            : role === "cover"
              ? 300
              : 140;
        await sh.picture(
          image.data,
          address,
          originalSlot?.width ||
            (role === "cover" ? 150 : role === "materials" ? 110 : 80),
          Math.max(20, originalSlot?.height || availableHeight),
        );
      }
    }
    for (const cell of sh.snapshot().cells) {
      if (protectedRow(cell.row)) continue;
      if (book.fontInfo(sh.style(cell.address)).vertical)
        writeTemplateCell(book, sh, cell.address, cell.value);
    }
    localizeSheetLabels(sh, role);
    const bounds = sh.bounds();
    result.push({
      ...sh.print(`A1:${colName(bounds.col)}${bounds.row}`),
      matched: true,
    });
  }
  return { buffer: await book.finish(), sheets: result, warnings };
}
