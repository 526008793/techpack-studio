import type {
  Box,
  Figure,
  FigureImage,
  PlacedAnnotation,
  TechPack,
} from "./model";

export const CAD_FONT = '"Microsoft YaHei", "PingFang SC", sans-serif';
export const CAD_COLOR = "#0000CC";
export function overlaps(a: Box, b: Box, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}
export function validBox(box: Box): boolean {
  return (
    Object.values(box).every(Number.isFinite) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x + box.width <= 1.001 &&
    box.y + box.height <= 1.001
  );
}
export function wrapAnnotation(
  text: string,
  width: number,
  measure: (s: string) => number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    // 分数、数值单位和英文词保持完整，避免把 3/8 或 1/4 英寸拆到两行。
    const tokens =
      paragraph.match(
        /\d+(?:[./]\d+)*(?:英寸|厘米|mm|cm|inches|inch|")?|[A-Za-z]+|\s+|./gu,
      ) || [];
    for (const token of tokens) {
      if (line && measure(line + token) > width) {
        lines.push(line);
        line = "";
      }
      line += token;
    }
    lines.push(line);
  }
  return lines;
}
// 所有坐标先转为裁图内的比例，再检验英文、图形和其他译文的占位。
export function placeAnnotations(
  figure: Figure,
  width: number,
  height: number,
  measure: (s: string, fontSize: number) => number,
  hasInk: (box: Box) => boolean,
): { annotations: PlacedAnnotation[]; warnings: string[] } {
  const local = (box: Box): Box => ({
    x: (box.x - figure.box.x) / figure.box.width,
    y: (box.y - figure.box.y) / figure.box.height,
    width: box.width / figure.box.width,
    height: box.height / figure.box.height,
  });
  const sources = figure.annotations.map((a) => local(a.sourceBox));
  const annotations: PlacedAnnotation[] = [],
    warnings: string[] = [];
  const fontSize = Math.max(18, width / 65),
    gapX = 6 / width,
    gapY = 6 / height;
  // 先给较短标注预留位置，避免长工艺段落占满面料编号旁的空白。
  const ordered = figure.annotations
    .map((annotation, index) => ({ annotation, index }))
    .sort((a, b) => a.annotation.textZh.length - b.annotation.textZh.length);
  for (const { index, annotation } of ordered) {
    const source = sources[index];
    if (!annotation.textZh.trim()) continue;
    if (!validBox(source) || !annotation.textEn.trim()) {
      warnings.push(
        `第${figure.page}页「${annotation.textEn || annotation.textZh}」英文位置超出裁图或缺失，请调整裁剪/标注后重试。`,
      );
      continue;
    }
    const candidates: Box[] = [];
    if (annotation.labelBox) candidates.push(local(annotation.labelBox));
    const widths = [
      ...new Set([Math.max(source.width, 0.15), 0.23, 0.32, 0.42, 0.1, 0.075]),
    ];
    for (const w of widths) {
      const lines = wrapAnnotation(annotation.textZh, w * width - 4, (s) =>
        measure(s, fontSize),
      );
      const h = (lines.length * fontSize * 1.25 + 4) / height;
      // 先下方/上方，再左右侧；候选位置始终围绕对应英文，避免移到图的另一端。
      for (const x of [
        source.x,
        source.x + source.width - w,
        source.x + 0.06,
        source.x + 0.12,
        source.x - 0.06,
        source.x - 0.12,
      ]) {
        for (const delta of [0, 0.012, 0.03, 0.06, 0.09]) {
          candidates.push({
            x,
            y: source.y + source.height + gapY + delta,
            width: w,
            height: h,
          });
          candidates.push({
            x,
            y: source.y - gapY - h - delta,
            width: w,
            height: h,
          });
        }
      }
      for (const y of [source.y, source.y + source.height - h]) {
        candidates.push({
          x: source.x + source.width + gapX,
          y,
          width: w,
          height: h,
        });
        candidates.push({ x: source.x - w - gapX, y, width: w, height: h });
      }
    }
    const distance = (a: Box, b: Box) =>
      Math.hypot(
        Math.max(0, a.x - b.x - b.width, b.x - a.x - a.width) * width,
        Math.max(0, a.y - b.y - b.height, b.y - a.y - a.height) * height,
      );
    // 占位只按文字实际尺寸计算，短编号不会占满模型给出的整块留白。
    const fit = (box: Box): Box => {
      const lines = wrapAnnotation(
        annotation.textZh,
        box.width * width - 4,
        (s) => measure(s, fontSize),
      );
      const neededHeight = (lines.length * fontSize * 1.25 + 4) / height;
      if (neededHeight > box.height + 0.01 / height) return box;
      return {
        ...box,
        width:
          (Math.max(...lines.map((line) => measure(line, fontSize))) + 4) /
          width,
        height: neededHeight,
      };
    };
    const preferred = annotation.labelBox
      ? fit(candidates.shift()!)
      : undefined;
    for (let i = 0; i < candidates.length; i++)
      candidates[i] = fit(candidates[i]);
    const score = (box: Box) =>
      distance(box, source) +
      wrapAnnotation(annotation.textZh, box.width * width - 4, (s) =>
        measure(s, fontSize),
      ).length *
        fontSize *
        0.8;
    candidates.sort((a, b) => score(a) - score(b));
    if (preferred) candidates.unshift(preferred);
    const box = candidates.find((candidate) => {
      if (!validBox(candidate)) return false;
      const dx = Math.max(
        0,
        candidate.x - source.x - source.width,
        source.x - candidate.x - candidate.width,
      );
      const dy = Math.max(
        0,
        candidate.y - source.y - source.height,
        source.y - candidate.y - candidate.height,
      );
      if (dx > 0.1 || dy > 0.1) return false;
      if (
        annotation.textZh.length <= 16 &&
        sources.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            distance(candidate, source) >
              distance(candidate, other) + fontSize * 0.8,
        )
      )
        return false;
      const lines = wrapAnnotation(
        annotation.textZh,
        candidate.width * width - 4,
        (s) => measure(s, fontSize),
      );
      return (
        lines.length * fontSize * 1.25 + 4 <=
          candidate.height * height + 0.01 &&
        lines.every(
          (line) => measure(line, fontSize) <= candidate.width * width - 4,
        ) &&
        !sources.some((s) =>
          overlaps(candidate, s, Math.min(gapX, gapY) / 2),
        ) &&
        !annotations.some((a) =>
          overlaps(candidate, a.box, Math.min(gapX, gapY)),
        ) &&
        !hasInk(candidate)
      );
    });
    if (box) {
      const lines = wrapAnnotation(
        annotation.textZh,
        box.width * width - 4,
        (s) => measure(s, fontSize),
      );
      annotations.push({
        textZh: lines.join("\n"),
        textEn: annotation.textEn,
        box,
        fontSize,
      });
    } else {
      warnings.push(
        `第${figure.page}页「${annotation.textEn}」附近空间不足，中文已列在图下，请在 Excel 中核对排版。`,
      );
    }
  }
  return { annotations, warnings };
}

const normalize = (text: string) =>
  text.toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
// 只消除已完整写到图中的工艺说明；局部标注不能让未呈现的要求丢失。
export function remainingConstruction(data: TechPack, figures: FigureImage[]) {
  const texts = figures.flatMap((f) =>
    (f.annotations || []).map((a) => ({
      en: normalize(a.textEn),
      zh: normalize(a.textZh),
    })),
  );
  return data.construction.filter((item) => {
    const detail = normalize(item.detailEn || "");
    const detailZh = normalize(item.detailZh || "");
    return !texts.some(
      (text) =>
        (detail && text.en.includes(detail)) ||
        (detailZh && text.zh.includes(detailZh)),
    );
  });
}

export function annotationWarnings(figures: FigureImage[]): string[] {
  const warnings = figures.flatMap((f) => f.annotationWarnings || []);
  if (
    figures.some(
      (f) =>
        f.role === "construction" &&
        !f.annotations?.length &&
        !f.unplacedAnnotations?.length,
    )
  )
    warnings.push(
      "工艺图没有可定位的中文标注，文字说明保留在图下；旧资料请重新识别以获取图中标注位置，也可在 Excel 中手工添加。",
    );
  return [...new Set(warnings)];
}

export function unplacedAnnotationRows(
  figures: FigureImage[],
  pending: TechPack["construction"],
) {
  const seen = new Set<string>();
  return figures
    .flatMap((f) => f.unplacedAnnotations || [])
    .filter((annotation) => {
      const zh = normalize(annotation.textZh),
        en = normalize(annotation.textEn);
      const key = zh + ":" + en;
      if (seen.has(key)) return false;
      seen.add(key);
      return !pending.some(
        (item) =>
          (zh && zh === normalize(item.detailZh || "")) ||
          (en && en === normalize(item.detailEn || "")),
      );
    });
}
