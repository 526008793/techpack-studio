import { z } from "zod";

const text = z.string().nullable();
const number = z.number().finite().nullable();
export const materialSchema = z
  .object({
    kind: z.enum(["fabric", "interlining", "graphic", "trim", "label"]),
    nameZh: text,
    nameEn: text,
    specZh: text,
    specEn: text,
    colors: z.array(z.string()),
    quantity: number,
    unitZh: text,
    unitEn: text,
    placementZh: text,
    placementEn: text,
    notesZh: text,
    notesEn: text,
  })
  .strict();
export const measurementSchema = z
  .object({
    nameZh: text,
    nameEn: text,
    value: number,
    tolerance: number,
    sourceValue: text,
    notes: text,
  })
  .strict();
export const boxSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite(),
    height: z.number().finite(),
  })
  .strict();
export const annotationSchema = z
  .object({
    textEn: z.string(),
    textZh: z.string(),
    sourceBox: boxSchema,
    labelBox: boxSchema.nullable(),
  })
  .strict();
export const figureSchema = z
  .object({
    role: z.enum([
      "appearance",
      "construction",
      "trimReference",
      "inspiration",
      "labels",
    ]),
    page: z.number().int().min(1),
    box: boxSchema,
    captionZh: text,
    captionEn: text,
    // 旧资料可以继续读取；新识别须同时提供英文标注与中文放置区域。
    annotations: z.array(annotationSchema).default([]),
  })
  .strict();
export const techPackSchema = z
  .object({
    meta: z
      .object({
        styleNumber: text,
        styleName: text,
        descriptionZh: text,
        descriptionEn: text,
        brand: text,
        customer: text,
        designer: text,
        technical: text,
        reference: text,
        season: text,
        sourceDate: text,
        sampleSize: text,
        sizeScale: z.array(z.string()),
        unit: z.enum(["inch", "cm"]),
        factory: text,
        orderNumber: text,
        merchandiser: text,
        issueDate: text,
        dueDate: text,
        sampleQuantity: number,
      })
      .strict(),
    materials: z.array(materialSchema),
    measurements: z.array(measurementSchema),
    construction: z.array(
      z
        .object({
          titleZh: text,
          titleEn: text,
          detailZh: text,
          detailEn: text,
        })
        .strict(),
    ),
    figures: z.array(figureSchema),
    missingItems: z.array(z.string()),
  })
  .strict();
export type TechPack = z.infer<typeof techPackSchema>;
export type Material = z.infer<typeof materialSchema>;
export type Measurement = z.infer<typeof measurementSchema>;
export type Figure = z.infer<typeof figureSchema>;
export type Box = z.infer<typeof boxSchema>;
export type FigureAnnotation = z.infer<typeof annotationSchema>;
export type PlacedAnnotation = {
  textZh: string;
  textEn: string;
  box: Box;
  fontSize: number;
  sourceIndex?: number;
  placement?: "nearby" | "side";
};
export type ApiSettings = {
  protocol: "responses" | "chat";
  baseUrl: string;
  model: string;
  reasoningEffort: "default" | "low" | "medium" | "high" | "xhigh";
  apiKey?: string;
  hasApiKey?: boolean;
  rememberKey: boolean;
};
export type CacheSettings = {
  directory: string;
  defaultDirectory: string;
};
export type PdfPage = {
  number: number;
  text: string;
  image: string;
  width: number;
  height: number;
  textBlocks?: { text: string; box: Box }[];
};
export type FigureImage = {
  role: Figure["role"];
  data: string;
  caption: string;
  annotations?: PlacedAnnotation[];
  annotationWarnings?: string[];
  unplacedAnnotations?: { textZh: string; textEn: string }[];
  thumbnailData?: string;
};
export type SelectedFile = {
  id: string;
  name: string;
  path: string;
  bytes: Uint8Array;
  sha256: string;
};
export type ExportSummary = {
  path: string;
  name: string;
};
export const TBC = "待确认 / TBC";
export const RISK_OPINION =
  "风险评估会意见：【版师在制版前找业务要客户原始资料或样衣照片，参考清晰图片做样】";
export function bilingual(
  zh: string | null | undefined,
  en: string | null | undefined,
): string {
  const a = zh?.trim(),
    b = en?.trim();
  return a && b ? `${a}\n${b}` : a || b || TBC;
}
export function normalizedMaterials(data: TechPack): Material[] {
  const items = data.materials.map((m) => ({ ...m, colors: [...m.colors] }));
  if (!items.some((m) => m.kind === "interlining")) {
    const last = items.reduce(
      (index, m, i) => (m.kind === "fabric" ? i : index),
      -1,
    );
    items.splice(last + 1, 0, {
      kind: "interlining",
      nameZh: "衬",
      nameEn: "INTERLINING",
      specZh: null,
      specEn: null,
      colors: [],
      quantity: null,
      unitZh: null,
      unitEn: null,
      placementZh: null,
      placementEn: null,
      notesZh: null,
      notesEn: null,
    });
  }
  return items;
}
export function emptyTechPack(): TechPack {
  return techPackSchema.parse({
    meta: {
      styleNumber: null,
      styleName: null,
      descriptionZh: null,
      descriptionEn: null,
      brand: null,
      customer: null,
      designer: null,
      technical: null,
      reference: null,
      season: null,
      sourceDate: null,
      sampleSize: null,
      sizeScale: [],
      unit: "inch",
      factory: null,
      orderNumber: null,
      merchandiser: null,
      issueDate: null,
      dueDate: null,
      sampleQuantity: null,
    },
    materials: [],
    measurements: [],
    construction: [],
    figures: [],
    missingItems: [],
  });
}
export function missingSummary(data: TechPack): string[] {
  const missing = [...data.missingItems];
  if (!data.meta.styleNumber) missing.push("款号未填写");
  if (!data.meta.sampleSize) missing.push("样码未提供");
  for (const m of normalizedMaterials(data)) {
    const name = m.nameZh || m.nameEn || "材料";
    if (!m.specZh && !m.specEn) missing.push(`${name}：规格待确认`);
    if (!m.placementZh && !m.placementEn)
      missing.push(`${name}：使用部位待确认`);
  }
  if (!data.measurements.length) missing.push("尺寸表尚无测量项目");
  return [...new Set(missing)];
}
export type DesktopApi = {
  platform: string;
  choosePdf(): Promise<SelectedFile | null>;
  chooseTemplate(): Promise<{
    id: string;
    name: string;
    sheets: string[];
  } | null>;
  settings(): Promise<ApiSettings>;
  saveSettings(settings: ApiSettings): Promise<ApiSettings>;
  cacheSettings(): Promise<CacheSettings>;
  chooseCacheDirectory(): Promise<CacheSettings | null>;
  resetCacheDirectory(): Promise<CacheSettings>;
  clearCache(): Promise<number>;
  uninstallApp(): Promise<void>;
  analyze(request: {
    fileId: string;
    pages: PdfPage[];
    force: boolean;
  }): Promise<{ data: TechPack; cached: boolean }>;
  cancelAnalysis(): Promise<void>;
  export(request: {
    data: TechPack;
    templateId: string | null;
    figures: FigureImage[];
  }): Promise<ExportSummary | null>;
  sample(): Promise<{ file: SelectedFile; data: TechPack }>;
  loadData(): Promise<TechPack | null>;
  saveData(data: TechPack): Promise<string | null>;
  openExport(path: string, folder: boolean): Promise<void>;
  onProgress(callback: (message: string) => void): () => void;
};
