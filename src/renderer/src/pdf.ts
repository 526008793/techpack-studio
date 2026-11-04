import { getDocument, GlobalWorkerOptions, Util } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type {
  PdfPage,
  Figure,
  FigureImage,
  PlacedAnnotation,
} from "../../shared/model";
import {
  CAD_COLOR,
  CAD_FONT,
  placeAnnotations,
  validBox,
  wrapAnnotation,
} from "../../shared/cad-annotations";
GlobalWorkerOptions.workerSrc = workerUrl;

export async function readPdf(
  bytes: Uint8Array,
  onPage: (current: number, total: number) => void,
): Promise<PdfPage[]> {
  const base = new URL("./pdf-assets/", window.location.href).href;
  const loading = getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: base + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: base + "standard_fonts/",
  });
  const pdf = await loading.promise;
  const pages: PdfPage[] = [];
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      onPage(number, pdf.numPages);
      const page = await pdf.getPage(number),
        normal = page.getViewport({ scale: 1 }),
        viewport = page.getViewport({
          scale: Math.min(2, 1800 / normal.width),
        });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({
        canvas,
        canvasContext: canvas.getContext("2d")!,
        viewport,
      }).promise;
      const text = await page.getTextContent();
      const textBlocks: NonNullable<PdfPage["textBlocks"]> = [];
      for (const item of text.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const transform = Util.transform(normal.transform, item.transform);
        const fontHeight = Math.hypot(transform[2], transform[3]);
        textBlocks.push({
          text: item.str,
          box: {
            x: Math.max(0, transform[4] / normal.width),
            y: Math.max(0, (transform[5] - fontHeight) / normal.height),
            width: item.width / normal.width,
            height: fontHeight / normal.height,
          },
        });
      }
      pages.push({
        number,
        text: text.items
          .map((item) =>
            "str" in item
              ? item.str + ("hasEOL" in item && item.hasEOL ? "\n" : " ")
              : "",
          )
          .join(""),
        image: canvas.toDataURL("image/jpeg", 0.88),
        width: normal.width,
        height: normal.height,
        textBlocks,
      });
      page.cleanup();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    await loading.destroy();
  }
  return pages;
}
const imageCache = new Map<string, Promise<HTMLImageElement>>();
function image(url: string) {
  let loaded = imageCache.get(url);
  if (!loaded) {
    loaded = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("PDF页面图片读取失败"));
      img.src = url;
    });
    imageCache.set(url, loaded);
  }
  return loaded;
}
export async function cropFigure(
  figure: Figure,
  pages: PdfPage[],
): Promise<string> {
  const page = pages[figure.page - 1];
  if (!page) return "";
  const source = await image(page.image),
    box = figure.box;
  const x = Math.max(0, Math.min(0.999, box.x)),
    y = Math.max(0, Math.min(0.999, box.y));
  const width = Math.min(Math.max(0.001, box.width), 1 - x),
    height = Math.min(Math.max(0.001, box.height), 1 - y);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.naturalWidth * width);
  canvas.height = Math.round(source.naturalHeight * height);
  canvas
    .getContext("2d")!
    .drawImage(
      source,
      source.naturalWidth * x,
      source.naturalHeight * y,
      source.naturalWidth * width,
      source.naturalHeight * height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  return canvas.toDataURL("image/png");
}
export async function exportFigures(
  figures: Figure[],
  pages: PdfPage[],
): Promise<FigureImage[]> {
  const output: FigureImage[] = [];
  for (const f of figures) {
    const figure = await prepareFigure(f, pages);
    if (figure) output.push(figure);
  }
  return output;
}
export async function prepareFigure(
  f: Figure,
  pages: PdfPage[],
): Promise<FigureImage | null> {
  const data = await cropFigure(f, pages);
  if (!data) return null;
  const source = await image(data);
  const canvas = document.createElement("canvas");
  canvas.width = source.naturalWidth;
  canvas.height = source.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(source, 0, 0);
  // 用缩小后的积分图快速检查文字框里是否已有英文、服装轮廓或红色引线。
  const scan = document.createElement("canvas");
  scan.width = Math.min(canvas.width, 700);
  scan.height = Math.round((canvas.height * scan.width) / canvas.width);
  const scanContext = scan.getContext("2d", { willReadFrequently: true })!;
  scanContext.drawImage(canvas, 0, 0, scan.width, scan.height);
  const pixels = scanContext.getImageData(0, 0, scan.width, scan.height).data;
  const stride = scan.width + 1,
    sums = new Uint32Array(stride * (scan.height + 1));
  for (let y = 1; y <= scan.height; y++) {
    let count = 0;
    for (let x = 1; x <= scan.width; x++) {
      const p = ((y - 1) * scan.width + x - 1) * 4;
      if (
        Math.min(pixels[p], pixels[p + 1], pixels[p + 2]) < 220 &&
        pixels[p + 3] > 128
      )
        count++;
      sums[y * stride + x] = sums[(y - 1) * stride + x] + count;
    }
  }
  const placed = placeAnnotations(
    f,
    canvas.width,
    canvas.height,
    (s, fontSize) => {
      context.font = `${fontSize}px ${CAD_FONT}`;
      return context.measureText(s).width;
    },
    (box) => {
      const x1 = Math.max(0, Math.floor(box.x * scan.width) - 1),
        y1 = Math.max(0, Math.floor(box.y * scan.height) - 1);
      const x2 = Math.min(
          scan.width,
          Math.ceil((box.x + box.width) * scan.width) + 1,
        ),
        y2 = Math.min(
          scan.height,
          Math.ceil((box.y + box.height) * scan.height) + 1,
        );
      const ink =
        sums[y2 * stride + x2] -
        sums[y1 * stride + x2] -
        sums[y2 * stride + x1] +
        sums[y1 * stride + x1];
      return ink > Math.max(1, (x2 - x1) * (y2 - y1) * 0.0005);
    },
  );
  let imageData = data;
  let annotations = placed.annotations;
  const pending = f.annotations
    .map((annotation, index) => ({ ...annotation, index }))
    .filter(
      (annotation) =>
        annotation.textZh.trim() &&
        annotation.textEn.trim() &&
        !annotations.some((item) => item.sourceIndex === annotation.index) &&
        validBox({
          x: (annotation.sourceBox.x - f.box.x) / f.box.width,
          y: (annotation.sourceBox.y - f.box.y) / f.box.height,
          width: annotation.sourceBox.width / f.box.width,
          height: annotation.sourceBox.height / f.box.height,
        }),
    );
  if (pending.length) {
    // 密集图在右侧扩白，保留对应英文；不把未放下的译文丢到单元格正文或静默省略。
    const padding = 18,
      fontSize = Math.max(18, canvas.width / 65);
    const englishSize = Math.max(14, fontSize * 0.7);
    const columnWidth = Math.max(320, canvas.width * 0.45);
    const textWidth = columnWidth - padding * 2;
    const rows = pending.map((annotation) => {
      context.font = `${englishSize}px ${CAD_FONT}`;
      const english = wrapAnnotation(
        `${annotation.index + 1}. ${annotation.textEn.replace(/\s+/g, " ")}`,
        textWidth,
        (text) => context.measureText(text).width,
      );
      context.font = `${fontSize}px ${CAD_FONT}`;
      const chinese = wrapAnnotation(
        annotation.textZh,
        textWidth - 4,
        (text) => context.measureText(text).width,
      );
      const chineseHeight = chinese.length * fontSize * 1.25 + 4;
      return {
        annotation,
        english,
        chinese,
        chineseHeight,
        height:
          english.length * englishSize * 1.25 + 8 + chineseHeight + padding,
      };
    });
    const top = padding + fontSize * 1.5;
    const tallest = Math.max(...rows.map((row) => row.height));
    const totalHeight = rows.reduce((total, row) => total + row.height, 0);
    let panelHeight = Math.max(canvas.height, top + padding + totalHeight);
    let bestScale = Infinity;
    // 兼顾图片宽高，避免把密集译文排成过长的横条后被 Excel 过度缩小。
    for (let columns = 1; columns <= rows.length; columns++) {
      const candidateHeight = Math.max(
        canvas.height,
        top + padding + totalHeight / columns + tallest,
      );
      const scale = Math.max(
        (canvas.width + columns * columnWidth) / canvas.width,
        candidateHeight / canvas.height,
      );
      if (scale < bestScale) {
        bestScale = scale;
        panelHeight = candidateHeight;
      }
    }
    let column = 0,
      y = top;
    const slots = rows.map((row) => {
      if (y + row.height > panelHeight - padding) {
        column++;
        y = top;
      }
      const slot = {
        ...row,
        x: canvas.width + column * columnWidth + padding,
        y,
      };
      y += row.height;
      return slot;
    });
    const expanded = document.createElement("canvas");
    expanded.width = Math.ceil(canvas.width + (column + 1) * columnWidth);
    expanded.height = Math.ceil(panelHeight);
    const expandedContext = expanded.getContext("2d")!;
    expandedContext.fillStyle = "#FFFFFF";
    expandedContext.fillRect(0, 0, expanded.width, expanded.height);
    expandedContext.drawImage(canvas, 0, 0);
    expandedContext.textBaseline = "top";
    expandedContext.fillStyle = "#333333";
    expandedContext.font = `${fontSize}px ${CAD_FONT}`;
    for (let c = 0; c <= column; c++)
      expandedContext.fillText(
        "图中译文",
        canvas.width + c * columnWidth + padding,
        padding,
      );
    annotations = annotations.map((annotation) => ({
      ...annotation,
      box: {
        x: (annotation.box.x * canvas.width) / expanded.width,
        y: (annotation.box.y * canvas.height) / expanded.height,
        width: (annotation.box.width * canvas.width) / expanded.width,
        height: (annotation.box.height * canvas.height) / expanded.height,
      },
    }));
    for (const slot of slots) {
      expandedContext.font = `${englishSize}px ${CAD_FONT}`;
      slot.english.forEach((line, index) =>
        expandedContext.fillText(
          line,
          slot.x,
          slot.y + index * englishSize * 1.25,
        ),
      );
      const label: PlacedAnnotation = {
        sourceIndex: slot.annotation.index,
        placement: "side",
        textEn: slot.annotation.textEn,
        textZh: slot.chinese.join("\n"),
        fontSize,
        box: {
          x: slot.x / expanded.width,
          y:
            (slot.y + slot.english.length * englishSize * 1.25 + 8) /
            expanded.height,
          width: textWidth / expanded.width,
          height: slot.chineseHeight / expanded.height,
        },
      };
      annotations.push(label);
    }
    imageData = expanded.toDataURL("image/png");
  }
  const unplaced = f.annotations.filter(
    (annotation, index) =>
      annotation.textZh.trim() &&
      !annotations.some((item) => item.sourceIndex === index),
  );
  return {
    role: f.role,
    data: imageData,
    caption: [f.captionZh, f.captionEn].filter(Boolean).join(" / "),
    annotations,
    annotationWarnings: unplaced.length ? placed.warnings : [],
    unplacedAnnotations: unplaced.map(({ textEn, textZh }) => ({
      textEn,
      textZh,
    })),
    thumbnailData: f.role === "appearance" ? styleThumbnail(canvas) : undefined,
  };
}
export async function previewFigure(
  f: Figure,
  pages: PdfPage[],
): Promise<{ image: string; figure: FigureImage | null }> {
  const prepared = await prepareFigure(f, pages);
  if (!prepared) return { image: "", figure: null };
  const source = await image(prepared.data),
    canvas = document.createElement("canvas");
  canvas.width = source.naturalWidth;
  canvas.height = source.naturalHeight;
  const context = canvas.getContext("2d")!;
  context.drawImage(source, 0, 0);
  context.fillStyle = CAD_COLOR;
  context.textBaseline = "top";
  for (const annotation of prepared.annotations || []) {
    context.font = `${annotation.fontSize}px ${CAD_FONT}`;
    annotation.textZh.split("\n").forEach((line, i) => {
      context.fillText(
        line,
        annotation.box.x * canvas.width + 2,
        annotation.box.y * canvas.height + 2 + i * annotation.fontSize * 1.25,
      );
    });
  }
  return { image: canvas.toDataURL("image/png"), figure: prepared };
}
export function parseDimension(text: string): number | null {
  const value = text.trim();
  if (!value) return null;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return Number(value);
  const fraction = /^([+-]?\d+\s+)?(\d+)\s*\/\s*(\d+)$/.exec(value);
  if (fraction && Number(fraction[3]) !== 0) {
    const whole = Number(fraction[1] || 0),
      part = Number(fraction[2]) / Number(fraction[3]);
    return whole < 0 ? whole - part : whole + part;
  }
  return null;
}

function styleThumbnail(source: HTMLCanvasElement): string {
  const scan = document.createElement("canvas");
  scan.width = Math.min(500, source.width);
  scan.height = Math.max(
    1,
    Math.round((source.height * scan.width) / source.width),
  );
  const context = scan.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(source, 0, 0, scan.width, scan.height);
  const pixels = context.getImageData(0, 0, scan.width, scan.height).data;
  const mask = new Uint8Array(scan.width * scan.height);
  for (let i = 0; i < mask.length; i++)
    mask[i] =
      pixels[i * 4 + 3] > 128 &&
      Math.min(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]) < 235
        ? 1
        : 0;
  const queue = new Int32Array(mask.length);
  let best:
    | {
        left: number;
        top: number;
        right: number;
        bottom: number;
        count: number;
      }
    | undefined;
  // 小款式图只取最大的连通服装主体，排除分离的标题、成分说明和整页细框。
  // 只供风险/耗料两处缩略图使用，原裁图及 CAD 图不变。
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start]) continue;
    let head = 0,
      tail = 1;
    queue[0] = start;
    mask[start] = 0;
    let left = start % scan.width,
      right = left,
      top = Math.floor(start / scan.width),
      bottom = top;
    while (head < tail) {
      const index = queue[head++],
        x = index % scan.width,
        y = Math.floor(index / scan.width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      for (const next of [
        x > 0 ? index - 1 : -1,
        x + 1 < scan.width ? index + 1 : -1,
        y > 0 ? index - scan.width : -1,
        y + 1 < scan.height ? index + scan.width : -1,
      ]) {
        if (next >= 0 && mask[next]) {
          mask[next] = 0;
          queue[tail++] = next;
        }
      }
    }
    const frame =
      right - left >= scan.width * 0.95 &&
      bottom - top >= scan.height * 0.95 &&
      tail < (right - left + 1) * (bottom - top + 1) * 0.1;
    if (!frame && (!best || tail > best.count))
      best = { left, top, right, bottom, count: tail };
  }
  if (!best) return source.toDataURL("image/png");
  const ratio = source.width / scan.width;
  const left = Math.max(0, (best.left - 2) * ratio),
    top = Math.max(0, (best.top - 2) * ratio);
  const width = Math.min(
    source.width - left,
    (best.right - best.left + 5) * ratio,
  );
  const height = Math.min(
    source.height - top,
    (best.bottom - best.top + 5) * ratio,
  );
  const thumbnail = document.createElement("canvas");
  thumbnail.width = Math.max(1, Math.round(width));
  thumbnail.height = Math.max(1, Math.round(height));
  thumbnail
    .getContext("2d")!
    .drawImage(
      source,
      left,
      top,
      width,
      height,
      0,
      0,
      thumbnail.width,
      thumbnail.height,
    );
  return thumbnail.toDataURL("image/png");
}
