import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PdfPage, Figure, FigureImage } from "../../shared/model";
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
    const data = await cropFigure(f, pages);
    if (data)
      output.push({
        role: f.role,
        data,
        caption: [f.captionZh, f.captionEn].filter(Boolean).join(" / "),
      });
  }
  return output;
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
