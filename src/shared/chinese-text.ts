import type { TechPack } from "./model";

export const CHINESE_TBC = "待确认";
const containsChinese = (value: string) => /[\u3400-\u9fff]/u.test(value);
const technicalIdentifier = (value: string) =>
  /^(?:[A-Z0-9]+(?:[-_.][A-Z0-9]+)+(?:\s+(?:TCX|TPX|TPG|C|U))?|#[0-9A-F]{6}|\d+(?:\.\d+)?\s*GSM|CVC|TYVEK|UFC)$/i.test(
    value.trim(),
  );
export function chinese(value: string | null | undefined): string {
  if (!value?.trim()) return CHINESE_TBC;
  const text = value
    .trim()
    .replace(/\bPDF\s+p\.?\s*(\d+)\b/gi, "PDF第$1页")
    .replace(/\bSIZE\b/g, "尺寸");
  // 旧资料的中文字段可能仍带“中文 / English”或重复英文行；保留中文和真实技术标识。
  const parts = text
    .split(/\r?\n|\s+\/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const kept = parts.filter(
    (part) => containsChinese(part) || technicalIdentifier(part),
  );
  return kept.join("\n") || CHINESE_TBC;
}

const colorNames: Record<string, string> = {
  BLACK: "黑色",
  WHITE: "白色",
  NAVY: "藏青色",
  BLUE: "蓝色",
  GREY: "灰色",
  GRAY: "灰色",
  RED: "红色",
  GREEN: "绿色",
  YELLOW: "黄色",
  BROWN: "棕色",
  BEIGE: "米色",
  PINK: "粉色",
  PURPLE: "紫色",
  ORANGE: "橙色",
  RAISIN: "葡萄干色",
  EGRET: "白鹭色",
  ANTHRACITE: "炭灰色",
  "DARK BLUE": "深蓝色",
};
// 老资料的常用色名可本地翻译；未知色名保留真实色号并明确待确认，不猜颜色。
export function chineseColor(value: string): string {
  const input = value.trim();
  const code = input
    .match(/\b\d{2}-\d{4}(?:\s*(?:TCX|TPX|TPG|C|U))?\b|#[0-9A-F]{6}\b/gi)
    ?.join(" ");
  if (/[\u3400-\u9fff]/u.test(value)) {
    const translated = input
      .split(/\r?\n/)
      .filter((line) => /[\u3400-\u9fff]/u.test(line))
      .map((line) => {
        let text = line;
        for (const name of Object.keys(colorNames).sort(
          (a, b) => b.length - a.length,
        ))
          text = text.replace(new RegExp(`\\b${name}\\b`, "gi"), "");
        return chinese(text.replace(/^[\s/／]+|[\s/／]+$/g, "").trim());
      })
      .join("\n");
    return [translated, code && !translated.includes(code) ? code : null]
      .filter(Boolean)
      .join(" ");
  }
  const name = input
    .replace(/\b\d{2}-\d{4}(?:\s*(?:TCX|TPX|TPG|C|U))?\b|#[0-9A-F]{6}\b/gi, "")
    .trim()
    .toUpperCase();
  if (colorNames[name])
    return [colorNames[name], code].filter(Boolean).join(" ");
  if (!name && code) return code;
  return code ? `${code}（色名待确认）` : CHINESE_TBC;
}

export function chineseExportWarnings(data: TechPack): string[] {
  const warnings: string[] = [];
  if (
    chinese(data.meta.descriptionZh) === CHINESE_TBC &&
    data.meta.descriptionEn?.trim()
  )
    warnings.push("品名只有英文，请补充中文品名；中文页不会回填英文。");
  data.materials.forEach((m, index) => {
    const name = m.nameZh || `材料${index + 1}`;
    for (const [label, zh, en] of [
      ["名称", m.nameZh, m.nameEn],
      ["规格", m.specZh, m.specEn],
      ["单位", m.unitZh, m.unitEn],
      ["部位", m.placementZh, m.placementEn],
      ["备注", m.notesZh, m.notesEn],
    ])
      if (chinese(zh) === CHINESE_TBC && en?.trim())
        warnings.push(`${name}：${label}缺少中文，请在核对页补充。`);
    for (const color of m.colors) {
      const translated = chineseColor(color);
      if (translated === CHINESE_TBC || translated.includes("色名待确认"))
        warnings.push(
          `${name}：颜色缺少可确认的中文色名，已保留原色号（如有），请在核对页补充。`,
        );
    }
  });
  return [...new Set(warnings)];
}

const labels: Record<string, string> = {
  ORDER: "订单",
  "ORDER NO": "订单号",
  "ORDER NUMBER": "订单号",
  STYLE: "款号",
  "STYLE NUMBER": "款号",
  "STYLE CODE": "款号",
  DESCRIPTION: "品名",
  CUSTOMER: "客户",
  CLIENT: "客户",
  BRAND: "品牌",
  FACTORY: "工厂",
  "SAMPLE QUANTITY": "样衣数量",
  "SAMPLE SIZE": "样码",
  "SAMPLE REQUIREMENTS": "数量搭配及打样要求",
  MERCHANDISER: "跟单",
  "MERCH.": "跟单",
  "PREPARED BY": "制单人",
  DATE: "日期",
  "ISSUE DATE": "发单日期",
  "DUE DATE": "交期",
  "TP DATE": "资料日期",
  "PATTERN MAKER": "版师",
  "MANAGER APPROVAL": "经理审核",
  FABRIC: "面料名称",
  TRIMS: "辅料名称",
  ITEM: "名称",
  MATERIAL: "物料",
  "BILL OF MATERIALS": "面辅料搭配表",
  SPEC: "规格",
  SPECIFICATION: "规格",
  QTY: "数量",
  QUANTITY: "数量",
  UNIT: "单位",
  PLACEMENT: "部位",
  USE: "部位",
  NOTES: "备注",
  TOTAL: "总计",
  "GRAND TOTAL": "总计",
  STAGE: "类别",
  SKETCH: "款式图",
  WIDTH: "幅宽",
  WARP: "经缩",
  WEFT: "纬缩",
  "NET USE": "净耗",
  WASTE: "损耗",
  QUOTED: "报价耗料",
  "MATERIAL CONSUMPTION": "耗料申请单",
  "FABRIC SWATCH CARD": "样衣面料留底卡",
  "SWATCH INFORMATION": "所需信息",
  INCH: "英寸",
  CM: "厘米",
};
// 仅用于已识别的栏目和标题，不处理品牌、款号、人名等业务原值。
export function chineseLabel(value: string, field?: string): string {
  const colon = value.search(/[：:]/);
  const heading = colon < 0 ? value : value.slice(0, colon);
  const suffix = colon < 0 ? "" : value.slice(colon);
  const key = heading.trim().toUpperCase();
  const color = key.match(/^COLORWAY\s*(\d*)$/);
  if (color) return `配色${color[1]}` + suffix;
  if (labels[key]) return labels[key] + suffix;
  if (!/[\u3400-\u9fff]/u.test(heading)) {
    const columns: Record<string, string> = {
      name: "名称",
      spec: "规格",
      placement: "部位",
      unit: "单位",
      notes: "备注",
      quantity: "数量",
      sampleQuantity: "样衣数量",
      productionQuantity: "生产数量",
      style: "款号",
      stage: "类别",
      image: "款式图",
      width: "幅宽",
      warp: "经缩",
      weft: "纬缩",
      net: "净耗",
      waste: "损耗",
      quote: "报价耗料",
    };
    if (field?.startsWith("color")) return "配色" + field.slice(5) + suffix;
    return field && columns[field] ? columns[field] + suffix : value;
  }
  const lines = heading
    .split(/\r?\n/)
    .filter((line) => /[\u3400-\u9fff]/u.test(line));
  return (
    lines
      .map((line) =>
        line.replace(/\s*[\/／]\s*[A-Za-z][A-Za-z0-9 .#&()_+\-/]*$/, "").trim(),
      )
      .join("\n") + suffix
  );
}
