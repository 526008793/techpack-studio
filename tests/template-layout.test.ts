import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser, XMLSerializer, type Element } from "@xmldom/xmldom";
import {
  emptyTechPack,
  RISK_OPINION,
  type Material,
} from "../src/shared/model";
import {
  generateTemplateWorkbook,
  inspectTemplate,
} from "../src/main/workbook";

const parse = (text: string) =>
  new DOMParser().parseFromString(text, "application/xml");
const stringify = (doc: ReturnType<typeof parse>) =>
  new XMLSerializer().serializeToString(doc);
const nodes = (doc: ReturnType<typeof parse> | Element, name: string) =>
  Array.from(doc.getElementsByTagNameNS("*", name));
const col = (index: number): string =>
  index > 26
    ? col(Math.floor((index - 1) / 26)) + col(((index - 1) % 26) + 1)
    : String.fromCharCode(64 + index);
const position = (address: string) => {
  const match = /^([A-Z]+)(\d+)$/.exec(address)!;
  return {
    col: [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0),
    row: Number(match[2]),
  };
};
async function fixture(selected: [string, string][]) {
  const zip = await JSZip.loadAsync(
    await fs.readFile(new URL("../resources/template.xlsx", import.meta.url)),
  );
  const book = parse(await zip.file("xl/workbook.xml")!.async("string"));
  const originals = nodes(book, "sheet");
  const container = originals[0].parentNode!;
  for (const sheet of originals) container.removeChild(sheet);
  for (const [source, name] of selected) {
    const sheet = originals
      .find((entry) => entry.getAttribute("name")!.trim() === source)!
      .cloneNode(true) as (typeof originals)[0];
    sheet.setAttribute("name", name);
    container.appendChild(sheet);
  }
  for (const name of nodes(book, "definedName"))
    name.parentNode!.removeChild(name);
  for (const view of nodes(book, "workbookView"))
    view.setAttribute("activeTab", "0");
  zip.file("xl/workbook.xml", stringify(book));
  return zip;
}
async function shift(
  zip: JSZip,
  file: string,
  columns: Record<number, number>,
  rows: number,
  fromRow = 1,
) {
  const doc = parse(await zip.file(file)!.async("string"));
  for (const row of nodes(doc, "row")) {
    const index = Number(row.getAttribute("r"));
    if (index < fromRow) continue;
    row.setAttribute("r", String(index + rows));
    for (const cell of Array.from(row.getElementsByTagNameNS("*", "c"))) {
      const p = position(cell.getAttribute("r")!);
      if (!columns[p.col]) {
        cell.parentNode!.removeChild(cell);
        continue;
      }
      cell.setAttribute("r", `${col(columns[p.col])}${p.row + rows}`);
    }
    const cells = Array.from(row.getElementsByTagNameNS("*", "c")).sort(
      (a, b) =>
        position(a.getAttribute("r")!).col - position(b.getAttribute("r")!).col,
    );
    for (const cell of cells) row.appendChild(cell);
  }
  for (const merge of nodes(doc, "mergeCell")) {
    if (position(merge.getAttribute("ref")!.split(":")[0]).row >= fromRow)
      merge.parentNode!.removeChild(merge);
  }
  const dimension = nodes(doc, "dimension")[0];
  dimension?.setAttribute(
    "ref",
    `A1:${col(Math.max(...Object.values(columns)))}100`,
  );
  zip.file(file, stringify(doc));
}
async function values(zip: JSZip, file: string) {
  const strings = nodes(
    parse(await zip.file("xl/sharedStrings.xml")!.async("string")),
    "si",
  ).map((s) =>
    Array.from(s.getElementsByTagNameNS("*", "t"))
      .map((t) => t.textContent)
      .join(""),
  );
  const cells = nodes(parse(await zip.file(file)!.async("string")), "c");
  return new Map(
    cells.map((c) => {
      const v = c.getElementsByTagNameNS("*", "v")[0]?.textContent || "";
      const text = Array.from(c.getElementsByTagNameNS("*", "t"))
        .map((t) => t.textContent)
        .join("");
      return [
        c.getAttribute("r")!,
        c.getAttribute("t") === "s" ? strings[Number(v)] : text || v,
      ];
    }),
  );
}
function data() {
  const data = emptyTechPack();
  Object.assign(data.meta, {
    styleNumber: "JACKET-NEW",
    descriptionZh: "新夹克",
    descriptionEn: "NEW JACKET",
    sampleSize: "M",
    unit: "inch",
  });
  data.materials = Array.from({ length: 5 }, (_, index): Material => ({
    kind: "fabric",
    nameZh: `面料${index + 1}`,
    nameEn: `FABRIC ${index + 1}`,
    specZh: "新规格",
    specEn: "NEW SPEC",
    colors: ["NAVY"],
    quantity: null,
    unitZh: "米",
    unitEn: "M",
    placementZh: "大身",
    placementEn: "BODY",
    notesZh: null,
    notesEn: null,
  }));
  data.measurements = [
    {
      nameZh: "胸围",
      nameEn: "CHEST",
      value: 44.25,
      tolerance: 0.25,
      sourceValue: "44 1/4",
      notes: null,
    },
    {
      nameZh: "零值",
      nameEn: "ZERO",
      value: 0,
      tolerance: 0,
      sourceValue: "0",
      notes: null,
    },
  ];
  return data;
}

test("renamed sheets and reordered columns fill by labels and preserve unknown sheets", async () => {
  const zip = await fixture([
    ["客人意见或邮件", "业务备忘"],
    ["面辅料配色表", "布料新位置"],
    ["尺寸表", "量体规格"],
  ]);
  await shift(
    zip,
    "xl/worksheets/sheet6.xml",
    { 1: 6, 2: 2, 3: 9, 4: 10, 5: 3, 6: 11, 7: 5, 8: 12 },
    3,
    5,
  );
  await shift(
    zip,
    "xl/worksheets/sheet7.xml",
    { 1: 8, 2: 3, 3: 6, 4: 7, 5: 2 },
    4,
  );
  const before = await zip.file("xl/worksheets/sheet9.xml")!.async("string");
  const book = parse(await zip.file("xl/workbook.xml")!.async("string"));
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  let definitions = nodes(book, "definedNames")[0];
  if (!definitions) {
    definitions = book.createElementNS(ns, "definedNames");
    book.documentElement!.appendChild(definitions);
  }
  const print = book.createElementNS(ns, "definedName");
  print.setAttribute("name", "_xlnm.Print_Area");
  print.setAttribute("localSheetId", "0");
  print.appendChild(book.createTextNode("'业务备忘'!$A$1:$B$3"));
  definitions.appendChild(print);
  zip.file("xl/workbook.xml", stringify(book));
  const output = await generateTemplateWorkbook(
    await zip.generateAsync({ type: "nodebuffer" }),
    data(),
  );
  const saved = await JSZip.loadAsync(output.buffer);
  assert.deepEqual(await inspectTemplate(output.buffer), [
    "业务备忘",
    "布料新位置",
    "量体规格",
  ]);
  assert.equal(
    await saved.file("xl/worksheets/sheet9.xml")!.async("string"),
    before,
  );
  assert.equal(output.sheets[0].matched, false);
  assert.ok(output.warnings.some((warning) => warning.includes("业务备忘")));
  const bom = await values(saved, "xl/worksheets/sheet6.xml");
  assert.match(bom.get("F9")!, /面料1/);
  assert.equal(bom.get("B9"), "新规格");
  assert.equal(bom.get("I9"), "藏青色");
  assert.equal(bom.get("E9"), "大身");
  assert.ok([...bom.values()].includes("衬"));
  const specs = await values(saved, "xl/worksheets/sheet7.xml");
  assert.equal(specs.get("F9"), "44.25");
  assert.equal(specs.get("B9"), "0.25");
  assert.equal(specs.get("F10"), "0");
  const bookOut = await saved.file("xl/workbook.xml")!.async("string");
  assert.ok(bookOut.includes("'业务备忘'!$A$1:$B$3"));
});

test("material row growth shifts original guidance and retains customer comments", async () => {
  const zip = await fixture([
    ["风险评估会", "生产评审"],
    ["客人意见或邮件", "客人意见或邮件"],
  ]);
  const before = await values(zip, "xl/worksheets/sheet9.xml");
  const output = await generateTemplateWorkbook(
    await zip.generateAsync({ type: "nodebuffer" }),
    data(),
  );
  const saved = await JSZip.loadAsync(output.buffer);
  const risk = await values(saved, "xl/worksheets/sheet8.xml");
  assert.equal(
    [...risk.values()].filter((value) => value === RISK_OPINION).length,
    1,
  );
  const opinion = [...risk].find(([, value]) => value === RISK_OPINION)![0];
  const riskDoc = parse(
    await saved.file("xl/worksheets/sheet8.xml")!.async("string"),
  );
  assert.ok(
    nodes(riskDoc, "mergeCell").some(
      (merge) =>
        merge.getAttribute("ref") === `${opinion}:G${position(opinion).row}`,
    ),
    "meeting guidance remains a full-width merged row below the materials",
  );
  assert.match([...risk.values()].join("\n"), /面料5/);
  assert.ok([...risk.values()].includes("衬"));
  assert.deepEqual(await values(saved, "xl/worksheets/sheet9.xml"), before);
  assert.equal(output.sheets.length, 2);
});

test("renamed sample pages preserve every footer cell and row format when colors add rows", async () => {
  const zip = await fixture([["数量搭配及打样要求", "打样安排"]]);
  const file = "xl/worksheets/sheet2.xml";
  const doc = parse(await zip.file(file)!.async("string"));
  const firstNote = nodes(doc, "c").find((c) => c.getAttribute("r") === "A10")!;
  while (firstNote.firstChild) firstNote.removeChild(firstNote.firstChild);
  firstNote.setAttribute("t", "inlineStr");
  const inline = doc.createElementNS(firstNote.namespaceURI, "is");
  const text = doc.createElementNS(firstNote.namespaceURI, "t");
  text.setAttribute("xml:space", "preserve");
  text.appendChild(
    doc.createTextNode(
      "  DATE: original terms / 客户原说明 PREPARED BY: 不修改  ",
    ),
  );
  inline.appendChild(text);
  firstNote.appendChild(inline);
  const sourceRows = nodes(doc, "row")
    .filter((r) => Number(r.getAttribute("r")) >= 10)
    .map((r) => r.cloneNode(true));
  zip.file(file, stringify(doc));
  const input = data();
  input.materials[0].colors = ["黑色", "白色", "红色", "蓝色", "绿色"];
  input.meta.merchandiser = "NEW PERSON";
  const output = await generateTemplateWorkbook(
    await zip.generateAsync({ type: "nodebuffer" }),
    input,
  );
  const saved = await JSZip.loadAsync(output.buffer);
  const actual = parse(await saved.file(file)!.async("string"));
  for (const sourceRow of sourceRows) {
    const expected = sourceRow as ReturnType<typeof nodes>[number];
    const oldRow = Number(expected.getAttribute("r"));
    const shifted = nodes(actual, "row")
      .find((r) => Number(r.getAttribute("r")) === oldRow + 3)!
      .cloneNode(true) as typeof expected;
    shifted.setAttribute("r", String(oldRow));
    for (const c of Array.from(shifted.getElementsByTagNameNS("*", "c"))) {
      const p = position(c.getAttribute("r")!);
      c.setAttribute("r", `${col(p.col)}${p.row - 3}`);
    }
    assert.equal(
      new XMLSerializer().serializeToString(shifted),
      new XMLSerializer().serializeToString(expected),
    );
  }
  assert.ok(
    nodes(actual, "mergeCell").some((m) => m.getAttribute("ref") === "A13:I13"),
  );
  assert.equal(output.sheets[0].name, "打样安排");
});

test("renamed CAD pages embed only supplied new images with standard drawing content types", async () => {
  const zip = await fixture([["CAD", "夹克工艺说明"]]);
  const png = await fs.readFile(
    new URL("../resources/app-icon.png", import.meta.url),
  );
  const output = await generateTemplateWorkbook(
    await zip.generateAsync({ type: "nodebuffer" }),
    data(),
    [
      {
        role: "construction",
        data: "data:image/png;base64," + png.toString("base64"),
        caption: "NEW JACKET SOURCE",
      },
    ],
  );
  const saved = await JSZip.loadAsync(output.buffer);
  const content = parse(
    await saved.file("[Content_Types].xml")!.async("string"),
  );
  const drawings = nodes(content, "Override").filter((node) =>
    node.getAttribute("PartName")!.startsWith("/xl/drawings/tp-"),
  );
  assert.equal(drawings.length, 1);
  assert.equal(
    drawings[0].getAttribute("ContentType"),
    "application/vnd.openxmlformats-officedocument.drawing+xml",
  );
  const media = Object.keys(saved.files).filter((name) =>
    name.startsWith("xl/media/tp-"),
  );
  assert.equal(media.length, 1);
  const rels = parse(
    await saved.file("xl/worksheets/_rels/sheet3.xml.rels")!.async("string"),
  );
  assert.equal(
    nodes(rels, "Relationship").filter((rel) =>
      rel.getAttribute("Type")?.endsWith("/drawing"),
    ).length,
    1,
    "old CAD drawing relationships are removed",
  );
  assert.deepEqual(await saved.file(media[0])!.async("nodebuffer"), png);
  assert.deepEqual(await inspectTemplate(output.buffer), ["夹克工艺说明"]);
});

test("multiple garment construction views are distributed across the existing CAD pages", async () => {
  const zip = await fixture([
    ["CAD", "工艺页一"],
    ["CAD-1", "工艺页二"],
    ["CAD-1 (2)", "工艺页三"],
    ["客人意见或邮件", "工艺页四"],
  ]);
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  for (const file of ["sheet3.xml", "sheet4.xml", "sheet5.xml", "sheet9.xml"]) {
    const doc = parse(await zip.file(`xl/worksheets/${file}`)!.async("string"));
    let row = nodes(doc, "row").find((r) => r.getAttribute("r") === "2");
    if (!row) {
      row = doc.createElementNS(ns, "row");
      row.setAttribute("r", "2");
      nodes(doc, "sheetData")[0].appendChild(row);
    }
    let cell = nodes(doc, "c").find((c) => c.getAttribute("r") === "A2");
    if (!cell) {
      cell = doc.createElementNS(ns, "c");
      cell.setAttribute("r", "A2");
      row.appendChild(cell);
    }
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    cell.setAttribute("t", "inlineStr");
    const text = doc.createElementNS(ns, "is");
    const value = doc.createElementNS(ns, "t");
    value.appendChild(doc.createTextNode("款式工艺图"));
    text.appendChild(value);
    cell.appendChild(text);
    zip.file(`xl/worksheets/${file}`, stringify(doc));
  }
  const png = await fs.readFile(
    new URL("../resources/app-icon.png", import.meta.url),
  );
  const figures = Array.from({ length: 4 }, (_, index) => ({
    role: "construction" as const,
    data: "data:image/png;base64," + png.toString("base64"),
    caption: `NEW VIEW ${index + 1}`,
  }));
  const output = await generateTemplateWorkbook(
    await zip.generateAsync({ type: "nodebuffer" }),
    data(),
    figures,
  );
  const saved = await JSZip.loadAsync(output.buffer);
  const drawings = Object.keys(saved.files).filter((file) =>
    /^xl\/drawings\/tp-.*\.xml$/.test(file),
  );
  assert.equal(drawings.length, 4);
  for (const file of drawings)
    assert.equal(
      nodes(parse(await saved.file(file)!.async("string")), "pic").length,
      1,
    );
  assert.equal(output.sheets.length, 4);
});

test("consumption production quantity never uses material usage or sample quantity", async () => {
  const zip = await fixture([["耗料单", "用料申请"]]);
  const pack = data();
  pack.meta.sampleQuantity = 99;
  pack.materials[0].quantity = 2;
  const output = await generateTemplateWorkbook(
    await zip.generateAsync({ type: "nodebuffer" }),
    pack,
  );
  const saved = await JSZip.loadAsync(output.buffer);
  const content = await values(saved, "xl/worksheets/sheet10.xml");
  assert.equal(content.get("D6"), "待确认");
  assert.match(content.get("E6")!, /新规格/);
  assert.match(content.get("E6")!, /藏青色/);
});

test("blank footer labels fill adjacent values while original formulas and mail are retained", async () => {
  const zip = await fixture([
    ["耗料单", "用料申请"],
    ["样衣面料留卡(2.0版)", "夹克留卡"],
    ["客人意见或邮件", "客人意见或邮件"],
  ]);
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  for (const [file, cells] of [
    ["sheet10.xml", { A20: "制单人：      ", B20: "OLD PERSON", N2: null }],
    ["sheet11.xml", { A3: "样品批次：", B3: "OLD STAGE" }],
    ["sheet9.xml", { A2: "ORIGINAL MAIL" }],
  ] as const) {
    const doc = parse(await zip.file(`xl/worksheets/${file}`)!.async("string"));
    for (const [address, text] of Object.entries(cells)) {
      let row = nodes(doc, "row").find(
        (r) => Number(r.getAttribute("r")) === position(address).row,
      );
      if (!row) {
        row = doc.createElementNS(ns, "row");
        row.setAttribute("r", String(position(address).row));
        nodes(doc, "sheetData")[0].appendChild(row);
      }
      let cell = nodes(doc, "c").find((c) => c.getAttribute("r") === address);
      if (!cell) {
        cell = doc.createElementNS(ns, "c");
        cell.setAttribute("r", address);
        row.appendChild(cell);
      }
      while (cell.firstChild) cell.removeChild(cell.firstChild);
      cell.setAttribute("t", "str");
      if (
        address.startsWith("B") ||
        address === "N2" ||
        file === "sheet9.xml"
      ) {
        const formula = doc.createElementNS(ns, "f");
        formula.appendChild(doc.createTextNode("[10]OldCover!D37"));
        cell.appendChild(formula);
      }
      if (text !== null) {
        const value = doc.createElementNS(ns, "v");
        value.appendChild(doc.createTextNode(text));
        cell.appendChild(value);
      }
    }
    zip.file(`xl/worksheets/${file}`, stringify(doc));
  }
  const originalMail = await values(zip, "xl/worksheets/sheet9.xml");
  const pack = data();
  pack.meta.merchandiser = "NEW PERSON";
  const output = await generateTemplateWorkbook(
    await zip.generateAsync({ type: "nodebuffer" }),
    pack,
  );
  const saved = await JSZip.loadAsync(output.buffer);
  const consumption = await values(saved, "xl/worksheets/sheet10.xml");
  const footer = [...consumption].find(
    ([, value]) => value === "制单人：      ",
  );
  assert.ok(footer);
  assert.equal(consumption.get(`B${position(footer[0]).row}`), "NEW PERSON");
  assert.equal(consumption.get("N2"), "");
  const swatches = await values(saved, "xl/worksheets/sheet11.xml");
  assert.equal(swatches.get("B3"), "待确认");
  for (const file of ["sheet10.xml", "sheet11.xml"]) {
    const doc = parse(
      await saved.file(`xl/worksheets/${file}`)!.async("string"),
    );
    assert.ok(
      nodes(doc, "f").some((f) => f.textContent === "[10]OldCover!D37"),
    );
  }
  assert.deepEqual(
    await values(saved, "xl/worksheets/sheet9.xml"),
    originalMail,
  );
  assert.ok(
    nodes(
      parse(await saved.file("xl/worksheets/sheet9.xml")!.async("string")),
      "f",
    ).some((f) => f.textContent === "[10]OldCover!D37"),
  );
  assert.ok(
    !output.warnings.some((w) => w.includes("N2") && w.includes("外部")),
  );
});

test("new material rows copy shared formulas with relative references and shift local links only", async () => {
  const zip = await fixture([
    ["面辅料配色表", "配色资料"],
    ["客人意见或邮件", "业务备忘"],
  ]);
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const source = parse(
    await zip.file("xl/worksheets/sheet6.xml")!.async("string"),
  );
  const phantom = source.createElementNS(ns, "mergeCell");
  phantom.setAttribute("ref", "V50:AB50");
  nodes(source, "mergeCells")[0].appendChild(phantom);
  for (const row of [6, 7, 8]) {
    const cell = nodes(source, "c").find(
      (c) => c.getAttribute("r") === `E${row}`,
    )!;
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    cell.removeAttribute("t");
    const formula = source.createElementNS(ns, "f");
    formula.setAttribute("t", "shared");
    formula.setAttribute("si", "23");
    if (row === 6) {
      formula.setAttribute("ref", "E6:E8");
      formula.appendChild(source.createTextNode('LEN(C6)+$M$1+N("C6")'));
    }
    cell.appendChild(formula);
  }
  zip.file("xl/worksheets/sheet6.xml", stringify(source));
  const other = parse(
    await zip.file("xl/worksheets/sheet9.xml")!.async("string"),
  );
  const row = nodes(other, "row")[0];
  for (const [address, text] of [
    ["N1", "'配色资料'!C9"],
    ["O1", "'[10]配色资料'!C9"],
  ]) {
    const cell = other.createElementNS(ns, "c");
    cell.setAttribute("r", address);
    const formula = other.createElementNS(ns, "f");
    formula.appendChild(other.createTextNode(text));
    cell.appendChild(formula);
    row.appendChild(cell);
  }
  zip.file("xl/worksheets/sheet9.xml", stringify(other));
  const output = await generateTemplateWorkbook(
    await zip.generateAsync({ type: "nodebuffer" }),
    data(),
  );
  const saved = await JSZip.loadAsync(output.buffer);
  assert.match(
    output.sheets[0].area,
    /:H\d+$/,
    "far-away blank merges must not add blank print pages",
  );
  const result = parse(
    await saved.file("xl/worksheets/sheet6.xml")!.async("string"),
  );
  for (let row = 6; row <= 11; row++) {
    const cell = nodes(result, "c").find(
      (c) => c.getAttribute("r") === `E${row}`,
    )!;
    assert.equal(nodes(cell, "f")[0].textContent, `LEN(C${row})+$M$1+N("C6")`);
    assert.equal(nodes(cell, "f")[0].hasAttribute("t"), false);
  }
  const linked = parse(
    await saved.file("xl/worksheets/sheet9.xml")!.async("string"),
  );
  assert.equal(
    nodes(
      nodes(linked, "c").find((c) => c.getAttribute("r") === "N1")!,
      "f",
    )[0].textContent,
    "'配色资料'!C12",
  );
  assert.equal(
    nodes(
      nodes(linked, "c").find((c) => c.getAttribute("r") === "O1")!,
      "f",
    )[0].textContent,
    "'[10]配色资料'!C9",
  );
});
