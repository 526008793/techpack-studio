import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import {
  techPackSchema,
  normalizedMaterials,
  RISK_OPINION,
  type TechPack,
} from "../src/shared/model";
import { generateWorkbook, inspectTemplate } from "../src/main/workbook";

const root = path.resolve(import.meta.dirname, "..");
async function fixture() {
  return techPackSchema.parse(
    JSON.parse(
      await fs.readFile(path.join(root, "resources/example.json"), "utf8"),
    ),
  );
}
async function xml(zip: JSZip, file: string) {
  return new DOMParser().parseFromString(
    await zip.file(file)!.async("string"),
    "application/xml",
  );
}
function cells(doc: ReturnType<DOMParser["parseFromString"]>) {
  const result = new Map<string, string>();
  for (const c of Array.from(doc.getElementsByTagNameNS("*", "c"))) {
    const value =
      Array.from(c.getElementsByTagNameNS("*", "t"))
        .map((t) => t.textContent || "")
        .join("") ||
      c.getElementsByTagNameNS("*", "v")[0]?.textContent ||
      "";
    result.set(c.getAttribute("r")!, value);
  }
  return result;
}

test("template profile, fabric separation and single added interlining", async () => {
  const template = await fs.readFile(
    path.join(root, "resources/template.xlsx"),
  );
  assert.equal((await inspectTemplate(template)).length, 11);
  const data = await fixture();
  assert.equal(data.measurements.length, 23);
  const materials = normalizedMaterials(data);
  assert.equal(materials.filter((m) => m.kind === "interlining").length, 1);
  assert.equal(
    normalizedMaterials({ ...data, materials }).filter(
      (m) => m.kind === "interlining",
    ).length,
    1,
  );
});

test("export keeps all POM values, fractions, required guidance and original mail page", async () => {
  const data = await fixture(),
    template = await fs.readFile(path.join(root, "resources/template.xlsx"));
  const output = await generateWorkbook(template, data, []),
    zip = await JSZip.loadAsync(output.buffer);
  assert.equal(output.sheets.length, 11);
  const spec = await xml(zip, "xl/worksheets/sheet7.xml"),
    values = cells(spec);
  data.measurements.forEach((m, index) => {
    assert.equal(Number(values.get(`C${index + 5}`)), m.value);
    assert.equal(Number(values.get(`E${index + 5}`)), m.tolerance);
  });
  for (const c of Array.from(spec.getElementsByTagNameNS("*", "c")).filter(
    (c) => /^C(?:[5-9]|1\d|2[0-7])$/.test(c.getAttribute("r") || ""),
  ))
    assert.notEqual(c.getAttribute("t"), "s");
  const bom = cells(await xml(zip, "xl/worksheets/sheet6.xml"));
  assert.match(bom.get("A6")!, /面料1/);
  assert.match(bom.get("A7")!, /面料2/);
  assert.match(bom.get("A8")!, /面料3/);
  assert.match(bom.get("A9")!, /衬/);
  const risk = cells(await xml(zip, "xl/worksheets/sheet8.xml"));
  assert.equal([...risk.values()].filter((v) => v === RISK_OPINION).length, 1);
  const before = await JSZip.loadAsync(template);
  assert.equal(
    await zip
      .file("xl/worksheets/sheet9.xml")!
      .async("string")
      .then((t) => t.includes("CUSTOMER TECH PACK")),
    false,
  );
  const mail = cells(await xml(zip, "xl/worksheets/sheet9.xml"));
  assert.deepEqual(
    [...mail].filter(([, v]) => v),
    [...cells(await xml(before, "xl/worksheets/sheet9.xml"))].filter(
      ([, v]) => v,
    ),
  );
  const book = await xml(zip, "xl/workbook.xml");
  assert.equal(
    Array.from(book.getElementsByTagNameNS("*", "definedName")).filter(
      (n) => n.getAttribute("name") === "_xlnm.Print_Area",
    ).length,
    11,
  );
  for (let i = 1; i <= 11; i++) {
    const doc = await xml(zip, `xl/worksheets/sheet${i}.xml`),
      setup = doc.getElementsByTagNameNS("*", "pageSetup")[0];
    assert.equal(setup.getAttribute("fitToHeight"), "1");
    assert.equal(setup.getAttribute("fitToWidth"), "1");
    assert.equal(setup.getAttribute("paperSize"), "9");
  }
  await fs.mkdir(path.join(root, "output/tests"), { recursive: true });
  await fs.writeFile(
    path.join(root, "output/tests/example-output.xlsx"),
    output.buffer,
  );
});

test("different style and material counts do not reuse previous style metadata", async () => {
  const data = await fixture();
  data.meta.styleNumber = "NEW-2026";
  data.meta.styleName = "ALEXA";
  data.materials = data.materials
    .filter((m) => m.kind === "fabric")
    .slice(0, 1);
  data.measurements = data.measurements.slice(0, 2);
  data.meta.sampleSize = "XL";
  data.meta.unit = "cm";
  data.materials[0].colors = ["BLUE 18-0000 TCX"];
  const out = await generateWorkbook(
      await fs.readFile(path.join(root, "resources/template.xlsx")),
      data,
      [],
    ),
    zip = await JSZip.loadAsync(out.buffer);
  for (const sheet of out.sheets.filter((s) => s.name !== "客人意见或邮件")) {
    const i = out.sheets.findIndex((s) => s.name === sheet.name) + 1,
      values = cells(await xml(zip, `xl/worksheets/sheet${i}.xml`));
    for (const v of values.values())
      assert.doesNotMatch(v, /S260954|P4507|邹双双|ADTN-Wallance/);
  }
  const spec = cells(await xml(zip, "xl/worksheets/sheet7.xml"));
  assert.equal(spec.get("E3"), "厘米 / CM");
  assert.equal(spec.get("C4"), "XL");
  assert.equal(
    out.sheets.find((s) => s.name === "面辅料配色表 ")?.area,
    "A1:H9",
  );
});
