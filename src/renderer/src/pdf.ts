import { getDocument, GlobalWorkerOptions, Util } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PdfPage, Figure, FigureImage } from "../../shared/model";
import {
  CAD_COLOR,
  CAD_FONT,
  placeAnnotations,
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
  return {
    role: f.role,
    data,
    caption: [f.captionZh, f.captionEn].filter(Boolean).join(" / "),
    annotations: placed.annotations,
    annotationWarnings: placed.warnings,
    unplacedAnnotations: f.annotations
      .filter(
        (a) =>
          a.textZh.trim() &&
          !placed.annotations.some((p) => p.textEn === a.textEn),
      )
      .map(({ textEn, textZh }) => ({ textEn, textZh })),
  };
}
export async function previewFigure(
  f: Figure,
  pages: PdfPage[],
): Promise<string> {
  const prepared = await prepareFigure(f, pages);
  if (!prepared) return "";
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
  return canvas.toDataURL("image/png");
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
