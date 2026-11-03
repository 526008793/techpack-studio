import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { emptyTechPack } from "../src/shared/model";
import {
  generateTemplateWorkbook,
  inspectTemplate,
} from "../src/main/workbook";

const input = process.argv[2];
if (!input)
  throw new Error(
    "Usage: npx tsx scripts/verify-template-layout.ts template.xlsx [output.xlsx] [test-image.png]",
  );
const output =
  process.argv[3] || path.resolve("output/templates/layout-test.xlsx");
const template = await fs.readFile(input);
const data = emptyTechPack();
Object.assign(data.meta, {
  styleNumber: "JACKET-TEST-2026",
  styleName: "HOODED JACKET TEST",
  descriptionZh: "连帽夹克适配测试",
  descriptionEn: "HOODED JACKET LAYOUT TEST",
  brand: "TEST BRAND",
  customer: "TEST CUSTOMER",
  merchandiser: "TEST MERCHANDISER",
  sampleSize: "M",
  sizeScale: ["S", "M", "L"],
  unit: "cm",
});
data.materials = Array.from({ length: 7 }, (_, index) => ({
  kind: index < 4 ? ("fabric" as const) : ("trim" as const),
  nameZh: `${index < 4 ? "测试面料" : "测试辅料"}${index + 1}`,
  nameEn: `TEST MATERIAL ${index + 1}`,
  specZh: "适配验证规格",
  specEn: "LAYOUT TEST SPECIFICATION",
  colors: ["BLACK", "NAVY", "GREY"],
  quantity: null,
  unitZh: "米",
  unitEn: "M",
  placementZh: "测试部位",
  placementEn: "TEST PLACEMENT",
  notesZh: null,
  notesEn: null,
}));
data.measurements = [
  {
    nameZh: "胸围",
    nameEn: "CHEST CIRCUMFERENCE",
    value: 112,
    tolerance: 1,
    sourceValue: "112",
    notes: null,
  },
  {
    nameZh: "衣长",
    nameEn: "BODY LENGTH",
    value: 72,
    tolerance: 0.5,
    sourceValue: "72",
    notes: null,
  },
  {
    nameZh: "袖长",
    nameEn: "SLEEVE LENGTH",
    value: 64,
    tolerance: 0.5,
    sourceValue: "64",
    notes: null,
  },
];
data.construction = [
  {
    titleZh: "连帽结构测试",
    titleEn: "HOOD TEST",
    detailZh: "本行为适配测试数据，不是生产指令",
    detailEn: "LAYOUT TEST DATA ONLY",
  },
];
const png = await fs.readFile(
  process.argv[4] || path.resolve("resources/app-icon.png"),
);
const image = "data:image/png;base64," + png.toString("base64");
data.figures = (
  [
    "appearance",
    "construction",
    "trimReference",
    "labels",
    "inspiration",
  ] as const
).map((role, index) => ({
  role,
  page: index + 1,
  box: { x: 0.15, y: 0.2, width: 0.7, height: 0.7 },
  captionZh: "适配测试图",
  captionEn: "LAYOUT TEST IMAGE",
}));
const result = await generateTemplateWorkbook(template, data, [
  { role: "appearance", data: image, caption: "夹克适配测试图" },
  { role: "construction", data: image, caption: "新资料工艺图测试" },
  { role: "trimReference", data: image, caption: "新资料辅料图测试" },
  { role: "labels", data: image, caption: "新资料唛头图测试" },
  { role: "inspiration", data: image, caption: "新资料参考图测试" },
]);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, result.buffer);
await fs.writeFile(
  output.replace(/\.xlsx$/i, ".data.json"),
  JSON.stringify(data, null, 2),
);
await fs.writeFile(
  output.replace(/\.xlsx$/i, ".json"),
  JSON.stringify({ sheets: result.sheets, warnings: result.warnings }, null, 2),
);
assert.deepEqual(
  await inspectTemplate(result.buffer),
  await inspectTemplate(template),
);
const zip = await JSZip.loadAsync(result.buffer);
const book = new DOMParser().parseFromString(
  await zip.file("xl/workbook.xml")!.async("string"),
  "application/xml",
);
assert.equal(
  book.getElementsByTagNameNS("*", "sheet").length,
  result.sheets.length,
);
for (const file of Object.keys(zip.files).filter((name) =>
  name.startsWith("xl/media/tp-"),
))
  assert.deepEqual(await zip.file(file)!.async("nodebuffer"), png);
console.log(
  JSON.stringify(
    { output, sheets: result.sheets, warnings: result.warnings },
    null,
    2,
  ),
);
