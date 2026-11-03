export type TemplateCell = {
  address: string;
  row: number;
  col: number;
  value: string | number;
  endCol: number;
};
export type TemplateSheet = { name: string; cells: TemplateCell[] };
export type TemplateRole =
  | "cover"
  | "sample"
  | "cad"
  | "materials"
  | "measurements"
  | "risk"
  | "mail"
  | "consumption"
  | "swatches"
  | "unknown";
export type TemplateColumn = { field: string; col: number; endCol: number };
export type TemplateTable = {
  row: number;
  columns: TemplateColumn[];
  group: "fabric" | "trim" | "all";
};

export const normalizeLabel = (value: unknown) =>
  String(value ?? "")
    .toUpperCase()
    .replace(/[\s：:（）()\[\]【】/\\_\-、，,。.+&]/g, "");

export function templateRole(sheet: TemplateSheet): TemplateRole {
  const content = sheet.cells
    .map((cell) => normalizeLabel(cell.value))
    .join("\n");
  const name = normalizeLabel(sheet.name);
  if (/客人意见|客户意见|邮件|CUSTOMERCOMMENTS|CUSTOMERMAIL/.test(name))
    return "mail";
  if (/风险评估会|风险评估|RISKASSESSMENT/.test(content)) return "risk";
  if (/面料留底卡|面料留卡|FABRICSWATCH|SWATCHCARD/.test(content + name))
    return "swatches";
  if (/耗料申请|耗料单|MATERIALCONSUMPTION|净单耗|填写报价耗料/.test(content))
    return "consumption";
  if (/数量搭配|打样要求|SAMPLEREQUIREMENTS/.test(content)) return "sample";
  if (
    /公差|TOLERANCE|^TOL$/m.test(content) &&
    /尺寸|测量|翻译|MEASUREMENT|CHINESE/.test(content)
  )
    return "measurements";
  if (
    /物料规格|面料名称|物料名称|面辅料搭配|BILLOFMATERIALS/.test(content) &&
    /配色|COLORWAY|使用部位|PLACEMENT/.test(content)
  )
    return "materials";
  if (
    /款式工艺图|CONSTRUCTION|LABELREFERENCES|TRIMSTYLEREFERENCES|唛头参考|辅料及款式参考/.test(
      content,
    ) ||
    /^CAD/.test(name)
  )
    return "cad";
  if (/经理审核|MANAGERAPPROVAL/.test(content) || /封面|COVER/.test(name))
    return "cover";
  return "unknown";
}

export function scalarField(value: unknown): string | null {
  const s = normalizeLabel(value);
  // 只匹配标签或“标签：原值”，不把旧资料的长段说明当成新数据。
  if (s.length > 80 || /风险评估会意见|所需信息/.test(s)) return null;
  if (/^(订单号样单号|样单号|款号|STYLENUMBER|STYLECODE|STYLE#)/.test(s))
    return "styleNumber";
  if (/^(订单号|订单ORDER|ORDERNO|ORDERNUMBER)/.test(s)) return "orderNumber";
  if (/^(产品名称|款式|品名|DESCRIPTION)/.test(s) && !/款式工艺|款式图/.test(s))
    return "description";
  if (
    /^(客户|客人|CLIENT|CUSTOMER)/.test(s) &&
    !/客人意见|客户意见|客户最终/.test(s)
  )
    return "customer";
  if (/^(品牌|BRAND)/.test(s)) return "brand";
  if (
    /^(业务跟单|跟单员|跟单|制单人|业务MERCH|MERCHANDISER|MERCH\b)/.test(s) ||
    s === "业务"
  )
    return "merchandiser";
  if (/^(生产工厂|工厂|FACTORY)/.test(s)) return "factory";
  if (/^(样品交期|交期|DUEDATE|SAMPLEDUE)/.test(s)) return "dueDate";
  if (
    /^(制单日期|发单日期|下单日期|申请日期|资料日期|ISSUEDATE|TPDATE)/.test(
      s,
    ) ||
    /^(日期|DATE)$/.test(s)
  )
    return "issueDate";
  if (/^(样衣数量|打样数量|SAMPLEQUANTITY)/.test(s)) return "sampleQuantity";
  if (/^(样码|样品尺码|SAMPLESIZE)/.test(s)) return "sampleSize";
  if (/^(尺寸单位|单位UNIT)/.test(s)) return "unit";
  if (
    /^(版师|经理审核|耗料师|样品批次|样衣批次|会议时间|会议地点|会议部门|参会人员|会议主讲|缺席|技术部|部门)/.test(
      s,
    )
  )
    return "clear";
  return null;
}

function tableField(value: unknown, role: TemplateRole): string | null {
  const s = normalizeLabel(value);
  if (role === "measurements") {
    if (/公差|TOLERANCE|^TOL/.test(s)) return "tolerance";
    if (/中文|翻译|CHINESE/.test(s)) return "nameZh";
    if (/测量部位|英文|^POM$|POINTOFMEASURE/.test(s)) return "nameEn";
    if (/样衣实测|SAMPLEMEASURED/.test(s)) return "clear";
    if (/^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-8]XL|样码|SIZE|SAMPLE)$/.test(s))
      return "value";
    return null;
  }
  if (/报价耗料|QUOTED/.test(s)) return "quote";
  if (/净单耗|净耗|NETUSE/.test(s)) return "net";
  if (/损耗|WASTE/.test(s)) return "waste";
  if (/经缩|径向缩率|经向缩率|WARP/.test(s)) return "warp";
  if (/纬缩|纬向缩率|WEFT/.test(s)) return "weft";
  if (/幅宽|WIDTH/.test(s)) return "width";
  if (/预算类别|类别STAGE|^STAGE/.test(s)) return "stage";
  if (/图片|款式图|SKETCH/.test(s)) return "image";
  if (/款号|^STYLE/.test(s)) return "style";
  if (/配色|COLORWAY|^COLOR[1-9]/.test(s))
    return `color${s.match(/[1-9]/)?.[0] || "1"}`;
  if (/备注|NOTES/.test(s)) return role === "risk" ? "placement" : "notes";
  if (/客人意见|客户意见/.test(s)) return "clear";
  if (/部位|用途|PLACEMENT|^USE$/.test(s)) return "placement";
  if (/规格|描述|SPEC/.test(s)) return "spec";
  if (/单位|^UNIT/.test(s)) return "unit";
  if (/样衣数量|样品数量|打样数量/.test(s)) return "sampleQuantity";
  if (/生产数量|大货数量|订单数量/.test(s)) return "productionQuantity";
  if (/数量|单耗|^QTY|QUANTITY/.test(s))
    return role === "consumption" && !/单耗/.test(s)
      ? "productionQuantity"
      : "quantity";
  if (/名称|^ITEM$|^MATERIAL|^FABRIC$|^TRIMS$/.test(s) && !/产品名称/.test(s))
    return "name";
  return null;
}

export function templateTables(
  sheet: TemplateSheet,
  role: TemplateRole,
): TemplateTable[] {
  const rows = [...new Set(sheet.cells.map((cell) => cell.row))];
  const result: TemplateTable[] = [];
  for (const row of rows) {
    const cells = sheet.cells.filter((cell) => cell.row === row);
    const columns = cells
      .map((cell) => ({
        field: tableField(cell.value, role),
        col: cell.col,
        endCol: cell.endCol,
      }))
      .filter((column): column is TemplateColumn => column.field !== null);
    const fields = new Set(columns.map((column) => column.field));
    const valid =
      role === "measurements"
        ? fields.has("tolerance") &&
          (fields.has("nameEn") || fields.has("nameZh") || fields.has("value"))
        : fields.has("name") &&
          (fields.has("spec") || fields.has("placement")) &&
          columns.length >= 3;
    if (!valid) continue;
    if (role === "measurements" && !fields.has("nameZh")) {
      const counts = new Map<number, number>();
      for (const cell of sheet.cells.filter(
        (c) =>
          c.row > row &&
          typeof c.value === "string" &&
          /[\u4e00-\u9fff]/.test(c.value) &&
          !columns.some((column) => column.col === c.col),
      ))
        counts.set(cell.col, (counts.get(cell.col) || 0) + 1);
      const chinese = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (chinese)
        columns.push({ field: "nameZh", col: chinese, endCol: chinese });
    }
    if (role === "measurements" && !fields.has("nameEn")) {
      const zh = columns.find((column) => column.field === "nameZh");
      const candidates = [
        ...new Set(
          sheet.cells
            .filter(
              (cell) =>
                cell.row > row &&
                cell.col !== zh?.col &&
                typeof cell.value === "string" &&
                /[A-Z]{3}/i.test(cell.value) &&
                !/^[A-Z]{1,4}$/.test(cell.value),
            )
            .map((cell) => cell.col),
        ),
      ];
      const english = candidates.sort(
        (a, b) =>
          sheet.cells.filter(
            (c) =>
              c.col === b &&
              c.row > row &&
              typeof c.value === "string" &&
              /[A-Z]{3}/i.test(c.value),
          ).length -
          sheet.cells.filter(
            (c) =>
              c.col === a &&
              c.row > row &&
              typeof c.value === "string" &&
              /[A-Z]{3}/i.test(c.value),
          ).length,
      )[0];
      if (english)
        columns.push({ field: "nameEn", col: english, endCol: english });
    }
    const header = normalizeLabel(cells.map((cell) => cell.value).join(" "));
    result.push({
      row,
      columns,
      group: /辅料名称|TRIMS/.test(header) ? "trim" : "fabric",
    });
  }
  return role === "measurements" ? result.slice(0, 1) : result;
}
