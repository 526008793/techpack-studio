import test from "node:test";
import assert from "node:assert/strict";
import { emptyTechPack, figureSchema, type Figure } from "../src/shared/model";
import {
  overlaps,
  placeAnnotations,
  remainingConstruction,
  validBox,
  wrapAnnotation,
  unplacedAnnotationRows,
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
test("wrapping retains dimensions and only fully rendered construction descriptions are removed", () => {
  const text = "脚口宽1英寸，压1/4英寸单针";
  const lines = wrapAnnotation(text, 100, (s) => [...s].length * 20);
  assert.equal(lines.join(""), text);
  assert.ok(lines.some((s) => s.includes("1/4英寸")));
  assert.ok(lines.every((s) => [...s].length * 20 <= 100));
  const data = emptyTechPack();
  data.construction = [
    {
      titleZh: "脚口",
      titleEn: "HEM",
      detailZh: text,
      detailEn: "1 INCH HEM; 1/4 INCH SINGLE NEEDLE",
    },
  ];
  const image = {
    role: "construction" as const,
    data: "",
    caption: "",
    annotations: [
      {
        textZh: "脚口宽1英寸",
        textEn: "1 INCH HEM",
        box: { x: 0, y: 0, width: 0.2, height: 0.1 },
        fontSize: 20,
      },
    ],
  };
  assert.equal(remainingConstruction(data, [image]).length, 1);
  image.annotations[0].textEn = data.construction[0].detailEn!;
  assert.equal(remainingConstruction(data, [image]).length, 0);
  const fallback = {
    ...image,
    unplacedAnnotations: [
      {
        textZh: data.construction[0].detailZh!,
        textEn: data.construction[0].detailEn!,
      },
      { textZh: "面料3：袋布", textEn: "FABRIC 3: PKT BAG" },
    ],
  };
  assert.equal(
    unplacedAnnotationRows([fallback, fallback], data.construction).length,
    1,
  );
  assert.equal(
    unplacedAnnotationRows([fallback], [])[0].textZh,
    data.construction[0].detailZh,
  );
});
