import test from "node:test";
import assert from "node:assert/strict";
import { figureSchema, type Figure } from "../src/shared/model";
import {
  overlaps,
  placeAnnotations,
  validBox,
  wrapAnnotation,
  annotationDisplay,
} from "../src/shared/cad-annotations";

const figure = (): Figure =>
  figureSchema.parse({
    role: "construction",
    page: 2,
    box: { x: 0.1, y: 0.2, width: 0.8, height: 0.7 },
    captionZh: null,
    captionEn: null,
    annotations: [
      {
        textEn: "FABRIC 1",
        textZh: "面料1",
        sourceBox: { x: 0.12, y: 0.3, width: 0.12, height: 0.02 },
        labelBox: { x: 0.12, y: 0.325, width: 0.16, height: 0.04 },
      },
    ],
  });
const measure = (s: string, font: number) => [...s].length * font;
test("legacy figures load without annotations; new schema requires annotation positions", () => {
  const { annotations: ignored, ...legacy } = figure();
  assert.deepEqual(figureSchema.parse(legacy).annotations, []);
  assert.equal(
    figureSchema.safeParse({
      ...legacy,
      annotations: [{ textEn: "FABRIC 1", textZh: "面料1" }],
    }).success,
    false,
  );
});
test("page coordinates become crop coordinates and labels stay beside the matched English", () => {
  const f = figure();
  const result = placeAnnotations(f, 1600, 1100, measure, () => false);
  assert.equal(result.annotations.length, 1);
  assert.deepEqual(result.warnings, []);
  const label = result.annotations[0];
  assert.ok(Math.abs(label.box.x - 0.025) < 1e-9);
  assert.ok(label.box.y > (0.3 - 0.2) / 0.7);
  assert.equal(label.textEn, "FABRIC 1");
  assert.equal(label.textZh, "面料1");
});
test("occupied model placement is rejected, nearby alternatives avoid source text and other labels", () => {
  const f = figure();
  f.annotations.push({
    ...f.annotations[0],
    textEn: "FABRIC 2",
    textZh: "面料2",
    sourceBox: { x: 0.12, y: 0.4, width: 0.12, height: 0.02 },
  });
  const result = placeAnnotations(
    f,
    1600,
    1100,
    measure,
    (box) => box.y > 0.17 && box.y < 0.2,
  );
  assert.equal(result.annotations.length, 2);
  assert.ok(!overlaps(result.annotations[0].box, result.annotations[1].box));
  assert.ok(result.annotations.every((a) => validBox(a.box)));
});
test("crowded diagrams and cropped English produce explicit warnings without overlay", () => {
  const f = figure();
  const blocked = placeAnnotations(f, 1600, 1100, measure, () => true);
  assert.equal(blocked.annotations.length, 0);
  assert.match(blocked.warnings[0], /FABRIC 1.*空间不足/);
  f.annotations[0].sourceBox.x = 0;
  const cropped = placeAnnotations(f, 1600, 1100, measure, () => false);
  assert.equal(cropped.annotations.length, 0);
  assert.match(cropped.warnings[0], /超出裁图/);
});
test("wrapping retains dimensions and units", () => {
  const text = "脚口宽1英寸，压1/4英寸单针";
  const lines = wrapAnnotation(text, 100, (s) => [...s].length * 20);
  assert.equal(lines.join(""), text);
  assert.ok(lines.some((s) => s.includes("1/4英寸")));
  assert.ok(lines.every((s) => [...s].length * 20 <= 100));
});

test("a translated label expands a short suggested box and keeps all characters", () => {
  const f = figure();
  f.annotations[0].labelBox!.height = 0.001;
  const result = placeAnnotations(f, 1600, 1100, measure, () => false);
  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0].sourceIndex, 0);
  assert.equal(
    result.annotations[0].textZh.replace(/\s/g, ""),
    f.annotations[0].textZh,
  );
  assert.ok(result.annotations[0].box.height > 0.001 / f.box.height);
});

test("fractional font widths do not cause an extra line at a floating-point boundary", () => {
  const lines = wrapAnnotation(
    "中文工艺",
    60.3 - 1e-10,
    (s) => s.length * 20.1,
  );
  assert.deepEqual(lines, ["中文工", "艺"]);
});

test("duplicate English labels and incomplete translations have distinct display states", () => {
  const f = figure();
  f.annotations.push({
    ...f.annotations[0],
    sourceBox: { x: 0.5, y: 0.5, width: 0.12, height: 0.02 },
  });
  const placed = placeAnnotations(
    f,
    1600,
    1100,
    measure,
    () => false,
  ).annotations;
  assert.equal(placed.length, 2);
  assert.deepEqual(
    annotationDisplay(f, placed).map((a) => a.status),
    ["placed", "placed"],
  );
  assert.deepEqual(
    annotationDisplay(f, placed.slice(0, 1)).map((a) => a.status),
    ["placed", "unplaced"],
  );
  assert.deepEqual(
    annotationDisplay(
      f,
      placed.map((a) => ({ ...a, textZh: "面料" })),
    ).map((a) => a.status),
    ["unplaced", "unplaced"],
  );
  f.annotations[0].textZh = "";
  assert.equal(annotationDisplay(f, placed)[0].status, "untranslated");
});
