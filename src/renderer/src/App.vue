<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  emptyTechPack,
  normalizedMaterials,
  missingSummary,
  techPackSchema,
  type TechPack,
  type SelectedFile,
  type PdfPage,
  type Material,
  type Figure,
  type ExportSummary,
  type ApiSettings,
  type CacheSettings,
} from "../../shared/model";
import { readPdf, previewFigure, exportFigures, parseDimension } from "./pdf";
import { annotationDisplay } from "../../shared/cad-annotations";
import brandIconUrl from "../../../build/icon.png?url";
import { version as appVersion } from "../../../package.json";

const api = window.techpack;
const step = ref(1),
  tab = ref("meta"),
  file = ref<SelectedFile | null>(null),
  pages = ref<PdfPage[]>([]),
  pageIndex = ref(0);
const template = ref<{ id: string; name: string; sheets: string[] } | null>(
    null,
  ),
  data = ref<TechPack>(emptyTechPack()),
  hasData = ref(false),
  busy = ref(false),
  status = ref(""),
  error = ref(""),
  notice = ref(""),
  sampleMode = ref(false),
  result = ref<ExportSummary | null>(null);
const settingsOpen = ref(false),
  savingSettings = ref(false),
  keyInput = ref(""),
  clearKey = ref(false);
const openMaterial = ref(0);
const cacheSettings = ref<CacheSettings>({
  directory: "",
  defaultDirectory: "",
});
const cacheBusy = ref(false),
  cacheMessage = ref("");
const settings = ref<ApiSettings>({
  protocol: "responses",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-6.1-sol",
  reasoningEffort: "xhigh",
  rememberKey: true,
});
const figurePreviews = ref<Awaited<ReturnType<typeof previewFigure>>[]>([]);
const previewBusy = ref(false);
const annotationReports = computed(() =>
  data.value.figures.map((figure, index) => {
    const items = annotationDisplay(
      figure,
      figurePreviews.value[index]?.figure?.annotations,
    );
    return {
      items,
      translated: items.filter((item) => item.status !== "untranslated").length,
      placed: items.filter((item) => item.status === "placed").length,
    };
  }),
);
const steps = ["导入资料", "核对中英内容", "导出制单"];
const tabs = [
  ["meta", "款式资料"],
  ["materials", "面辅料"],
  ["measurements", "尺寸表"],
  ["construction", "工艺要求"],
  ["figures", "图片参考"],
];
const kindNames: Record<Material["kind"], string> = {
  fabric: "面料",
  interlining: "衬",
  graphic: "绣章/图案",
  trim: "辅料",
  label: "唛头",
};
const roleNames: Record<Figure["role"], string> = {
  appearance: "款式彩色图",
  construction: "工艺图",
  trimReference: "辅料参考",
  inspiration: "款式参考",
  labels: "唛头参考",
};
const missing = computed(() =>
  hasData.value ? missingSummary(data.value) : [],
);
const fabrics = computed(
  () =>
    data.value.materials.filter(
      (m) => m.kind === "fabric" || m.kind === "interlining",
    ).length,
);
const activePage = computed(() => pages.value[pageIndex.value]);
const jsonData = () => JSON.parse(JSON.stringify(data.value)) as TechPack;
let removeProgress: undefined | (() => void),
  previewVersion = 0;
async function action(fn: () => Promise<void>) {
  error.value = "";
  notice.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = (e instanceof Error ? e.message : String(e)).replace(
      /^Error invoking remote method '[^']+': Error: /,
      "",
    );
  }
}
async function loadPdf(selected: SelectedFile) {
  file.value = selected;
  pages.value = [];
  pageIndex.value = 0;
  pages.value = await readPdf(
    selected.bytes,
    (current, total) =>
      (status.value = `正在读取 PDF：${current} / ${total} 页`),
  );
  status.value = `已读取 ${pages.value.length} 页资料`;
}
async function choosePdf() {
  await action(async () => {
    const selected = await api.choosePdf();
    if (!selected) return;
    busy.value = true;
    try {
      await loadPdf(selected);
      hasData.value = false;
      result.value = null;
      sampleMode.value = false;
    } finally {
      busy.value = false;
    }
  });
}
async function chooseTemplate() {
  await action(async () => {
    const selected = await api.chooseTemplate();
    if (selected) template.value = selected;
  });
}
function useBuiltinTemplate() {
  template.value = null;
  error.value = "";
  notice.value = "已使用内置 11 页模板，无需再选择其他模板。";
}
function acceptData(value: TechPack) {
  const validated = techPackSchema.parse(value);
  validated.materials = normalizedMaterials(validated);
  data.value = validated;
  hasData.value = true;
  result.value = null;
  step.value = 2;
  tab.value = "meta";
  openMaterial.value = 0;
}
async function analyze(force = false) {
  await action(async () => {
    if (!file.value) throw new Error("请先选择PDF资料");
    busy.value = true;
    try {
      const answer = await api.analyze({
        fileId: file.value.id,
        pages: JSON.parse(JSON.stringify(pages.value)),
        force,
      });
      acceptData(answer.data);
      sampleMode.value = false;
      notice.value = answer.cached
        ? "已使用本地缓存，没有再次调用模型。"
        : "识别已完成，请重点核对尺寸、用量及待确认项。";
    } finally {
      busy.value = false;
    }
  });
}
async function sample() {
  await action(async () => {
    busy.value = true;
    try {
      const value = await api.sample();
      await loadPdf(value.file);
      acceptData(value.data);
      sampleMode.value = true;
      notice.value = "当前为已核对的 P4541 示例，未调用模型。";
    } finally {
      busy.value = false;
    }
  });
}
function manual() {
  acceptData(emptyTechPack());
  notice.value = "可手动填写资料；也可返回导入页，使用模型识别PDF。";
}
async function importData() {
  await action(async () => {
    const value = await api.loadData();
    if (value) {
      acceptData(value);
      notice.value = "已加载保存的资料。选择原PDF后可补齐图片参考。";
    }
  });
}
async function saveData() {
  await action(async () => {
    const file = await api.saveData(jsonData());
    if (file) notice.value = "资料已保存，以后可导入继续修改。";
  });
}
async function saveSettings() {
  await action(async () => {
    savingSettings.value = true;
    try {
      const payload = {
        ...settings.value,
        apiKey: clearKey.value ? "" : keyInput.value.trim() || undefined,
      };
      settings.value = await api.saveSettings(payload);
      keyInput.value = "";
      clearKey.value = false;
      settingsOpen.value = false;
      notice.value = "模型设置已保存。";
    } finally {
      savingSettings.value = false;
    }
  });
}
async function changeCache(mode: "choose" | "reset" | "clear") {
  cacheBusy.value = true;
  cacheMessage.value = "";
  await action(async () => {
    try {
      if (mode === "clear") {
        const count = await api.clearCache();
        cacheMessage.value = `已清理 ${count} 个缓存文件，下次识别会重新调用 AI。`;
        notice.value = cacheMessage.value;
      } else {
        const value =
          mode === "choose"
            ? await api.chooseCacheDirectory()
            : await api.resetCacheDirectory();
        if (value) {
          cacheSettings.value = value;
          cacheMessage.value = "缓存位置已保存，立即生效。";
        }
      }
    } finally {
      cacheBusy.value = false;
    }
  });
}
async function uninstallApp() {
  cacheBusy.value = true;
  await action(async () => {
    try {
      await api.uninstallApp();
    } finally {
      cacheBusy.value = false;
    }
  });
}
function addMaterial() {
  data.value.materials.push({
    kind: "fabric",
    nameZh: null,
    nameEn: null,
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
  openMaterial.value = data.value.materials.length - 1;
}
function addMeasurement() {
  data.value.measurements.push({
    nameZh: null,
    nameEn: null,
    value: null,
    tolerance: null,
    sourceValue: null,
    notes: null,
  });
}
function dimension(index: number, key: "value" | "tolerance", value: string) {
  const parsed = parseDimension(value);
  if (value.trim() && parsed === null && key === "tolerance") {
    error.value = "公差请填写数值或分数，例如 0.5、1/8。";
    return;
  }
  const row = data.value.measurements[index];
  row[key] = parsed;
  if (key === "value") row.sourceValue = parsed === null ? value || null : null;
}
function colors(index: number, value: string) {
  data.value.materials[index].colors = value
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);
}
function addFigure() {
  data.value.figures.push({
    role: "construction",
    page: 1,
    box: { x: 0, y: 0, width: 1, height: 1 },
    captionZh: null,
    captionEn: null,
    annotations: [],
  });
}
function setBox(index: number, key: keyof Figure["box"], event: Event) {
  const value = Number((event.target as HTMLInputElement).value) / 100;
  if (Number.isFinite(value))
    data.value.figures[index].box[key] = Math.max(0, Math.min(1, value));
}
async function updatePreviews() {
  const version = ++previewVersion;
  previewBusy.value = true;
  const images = await Promise.all(
    data.value.figures.map((f) =>
      previewFigure(f, pages.value).catch(() => ({ image: "", figure: null })),
    ),
  );
  if (version === previewVersion) {
    figurePreviews.value = images;
    previewBusy.value = false;
  }
}
watch(
  () => data.value.figures,
  () => void updatePreviews(),
  { deep: true },
);
watch(pages, () => void updatePreviews());
async function exportWorkbook() {
  await action(async () => {
    busy.value = true;
    try {
      status.value = "正在准备图片和制单…";
      const document = jsonData();
      const figures = await exportFigures(document.figures, pages.value);
      const output = await api.export({
        data: document,
        templateId: template.value?.id || null,
        figures,
      });
      if (output) {
        result.value = output;
        step.value = 3;
        notice.value = "Excel 已生成，可在 Excel 或 WPS 中继续修改。";
      }
    } finally {
      busy.value = false;
    }
  });
}
onMounted(() => {
  if (!api) {
    error.value = "请从已安装的制单助手打开。";
    return;
  }
  removeProgress = api.onProgress((text) => (status.value = text));
  void action(async () => {
    [settings.value, cacheSettings.value] = await Promise.all([
      api.settings(),
      api.cacheSettings(),
    ]);
  });
});
onUnmounted(() => removeProgress?.());
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <img class="brand-icon" :src="brandIconUrl" alt="ZHH" />
        <div><strong>制单助手</strong><small>TECHPACK STUDIO</small></div>
      </div>
      <div class="workflow-label">制单流程</div>
      <nav class="steps">
        <button
          v-for="(name, index) in steps"
          :key="name"
          :class="{ active: step === index + 1, done: step > index + 1 }"
          :disabled="index > 0 && !hasData"
          @click="step = index + 1"
        >
          <span class="step-number">{{
            step > index + 1 ? "✓" : index + 1
          }}</span
          ><span>{{ name }}</span
          ><span v-if="step === index + 1" class="nav-dot"></span>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <button
          class="settings-link"
          @click="changeCache('clear')"
          :disabled="busy || cacheBusy"
        >
          <span>⌫</span> 清除缓存
        </button>
        <button class="settings-link" @click="settingsOpen = true">
          <span>⚙</span> 模型与 API 设置
          <b v-if="settings.hasApiKey" class="connected-dot"></b></button
        ><small>本地文件处理 · v{{ appVersion }}</small>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <span class="breadcrumb">制单工作台</span><span class="slash">/</span
          ><strong>{{ steps[step - 1] }}</strong>
        </div>
        <div class="top-actions">
          <span v-if="sampleMode" class="pill">示例资料</span
          ><button class="text-button" @click="importData" :disabled="busy">
            导入已存资料</button
          ><button
            v-if="hasData"
            class="text-button"
            @click="saveData"
            :disabled="busy"
          >
            保存资料
          </button>
        </div>
      </header>
      <div class="content">
        <div v-if="error && !settingsOpen" class="alert error" role="alert">
          <strong>操作未完成</strong><span>{{ error }}</span
          ><button @click="error = ''" aria-label="关闭提示">×</button>
        </div>
        <div v-if="notice" class="alert success" role="status">
          <span>{{ notice }}</span
          ><button @click="notice = ''" aria-label="关闭通知">×</button>
        </div>

        <template v-if="step === 1">
          <div class="page-heading">
            <div>
              <span class="eyebrow">01 / 导入</span>
              <h1>开始一份新制单</h1>
              <p>选择新收到的 PDF，CAD 和尺寸页中英对照，其余填写中文。</p>
            </div>
            <button class="secondary" @click="sample" :disabled="busy">
              查看 P4541 示例 <span>↗</span>
            </button>
          </div>
          <div class="import-grid">
            <section class="import-card" :class="{ selected: file }">
              <div class="card-top">
                <span class="file-type pdf-type">PDF</span
                ><span class="small-label">新款资料</span>
              </div>
              <h2>{{ file ? file.name : "选择 PDF 资料文件" }}</h2>
              <p>
                {{
                  file
                    ? `${pages.length} 页 · ${(file.bytes.length / 1024 / 1024).toFixed(1)} MB`
                    : "支持文字版、扫描件及包含工艺图片的技术资料。"
                }}
              </p>
              <div class="file-placeholder" v-if="!file">
                <svg width="54" height="62" viewBox="0 0 54 62" fill="none">
                  <path
                    d="M10 2h24l15 15v40a3 3 0 0 1-3 3H10a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4Z"
                    stroke="currentColor"
                    stroke-width="1.5"
                  />
                  <path
                    d="M33 3v16h15M17 31h20M17 39h20M17 47h12"
                    stroke="currentColor"
                    stroke-width="1.5"
                  /></svg
                ><span>导入完整资料，保留原始内容</span>
              </div>
              <div v-else class="selected-pdf">
                <img
                  v-if="pages[0]"
                  :src="pages[0].image"
                  alt="PDF第一页预览"
                /><span
                  ><b>已读取 {{ pages.length }} 页</b
                  ><small>原文件不会被修改</small></span
                >
              </div>
              <button class="primary" @click="choosePdf" :disabled="busy">
                {{ file ? "重新选择 PDF" : "选择 PDF 文件" }} <span>＋</span>
              </button>
            </section>
            <section class="import-card">
              <div class="card-top">
                <span class="file-type excel-type">XLSX</span
                ><span class="small-label">制单格式</span>
              </div>
              <h2>{{ template?.name || "使用已确认的制单模板" }}</h2>
              <p>保留公司抬头、工作表和主要格式，材料不足时自动增加行。</p>
              <div class="template-preview">
                <div class="mini-sheet">
                  <i></i>
                  <div v-for="n in 5" :key="n">
                    <span></span><span></span><span></span><span></span>
                  </div>
                </div>
                <div>
                  <strong>{{
                    template
                      ? `自定义模板 · ${template.sheets.length} 个工作表`
                      : "内置 11 页模板"
                  }}</strong
                  ><span>面辅料 · 尺寸 · 工艺 · 耗料 · 留卡</span
                  ><small>Excel 页面自动适配</small>
                </div>
              </div>
              <div class="template-actions">
                <button
                  class="secondary"
                  @click="chooseTemplate"
                  :disabled="busy"
                >
                  选择其他模板</button
                ><button
                  class="text-button"
                  @click="useBuiltinTemplate"
                  :disabled="busy"
                >
                  使用内置模板
                </button>
              </div>
              <small class="hint"
                >自定义模板按表头和标签定位，保留原有工作表和顺序。旧版 .xls
                会在本地自动转换，原模板文件不会被覆盖。</small
              >
            </section>
          </div>
          <section class="how-it-works">
            <div>
              <span>01</span><strong>读取资料</strong>
              <p>识别文字、表格和技术图</p>
            </div>
            <i>→</i>
            <div>
              <span>02</span><strong>核对内容</strong>
              <p>CAD 和尺寸中英对照，其余中文，可逐项修改</p>
            </div>
            <i>→</i>
            <div>
              <span>03</span><strong>生成制单</strong>
              <p>替换旧款、保留模板格式</p>
            </div>
          </section>
          <div class="bottom-action">
            <div>
              <strong>{{
                busy
                  ? status
                  : file
                    ? "资料已准备，可以开始识别"
                    : "先选择一份新资料"
              }}</strong
              ><small
                >识别时会将 PDF
                页面发送到你配置的模型服务；导出在本地完成。</small
              >
            </div>
            <div class="button-row">
              <button class="text-button" @click="manual" :disabled="busy">
                手动填写</button
              ><button
                v-if="busy"
                class="secondary"
                @click="api.cancelAnalysis()"
              >
                取消识别</button
              ><button
                class="primary"
                @click="analyze()"
                :disabled="busy || !pages.length"
              >
                <span v-if="busy" class="spinner"></span
                >{{ busy ? "处理中…" : "识别并整理资料" }}
                <span v-if="!busy">→</span>
              </button>
            </div>
          </div>
        </template>

        <template v-else-if="step === 2">
          <div class="page-heading compact">
            <div>
              <span class="eyebrow">02 / 核对</span>
              <h1>
                {{
                  [data.meta.styleNumber, data.meta.styleName]
                    .filter(Boolean)
                    .join(" ") || "新款资料"
                }}
              </h1>
              <p>核对后导出。空白项会在制单中显示为“待确认”，不会自行推算。</p>
            </div>
            <div class="summary-count">
              <strong>{{ data.materials.length }}</strong
              ><span>项材料</span><i></i
              ><strong>{{ data.measurements.length }}</strong
              ><span>项尺寸</span>
            </div>
          </div>
          <div class="review-layout">
            <section class="review-panel">
              <div class="tabs" role="tablist">
                <button
                  v-for="[id, name] in tabs"
                  :key="id"
                  :class="{ active: tab === id }"
                  @click="tab = id"
                  role="tab"
                  :aria-selected="tab === id"
                >
                  {{ name }}
                </button>
              </div>
              <div v-if="tab === 'meta'" class="form-body">
                <div class="section-heading">
                  <h2>款式与资料信息</h2>
                  <span>中英文对应保留</span>
                </div>
                <div class="field-grid">
                  <label
                    >款号<input
                      v-model="data.meta.styleNumber"
                      placeholder="如 P4541" /></label
                  ><label
                    >款名<input
                      v-model="data.meta.styleName"
                      placeholder="如 RANDY" /></label
                  ><label>品牌<input v-model="data.meta.brand" /></label
                  ><label>客户<input v-model="data.meta.customer" /></label
                  ><label class="full"
                    >中文品名<input v-model="data.meta.descriptionZh" /></label
                  ><label class="full"
                    >英文品名<input v-model="data.meta.descriptionEn" /></label
                  ><label
                    >样码<input
                      v-model="data.meta.sampleSize"
                      placeholder="如 M" /></label
                  ><label
                    >尺码范围<input
                      :value="data.meta.sizeScale.join(' / ')"
                      @change="
                        data.meta.sizeScale = (
                          $event.target as HTMLInputElement
                        ).value
                          .split(/\s*[/,，、]\s*/)
                          .filter(Boolean)
                      "
                      placeholder="S / M / L / XL / XXL" /></label
                  ><label
                    >尺寸单位<select v-model="data.meta.unit">
                      <option value="inch">英寸 / INCH</option>
                      <option value="cm">厘米 / CM</option>
                    </select></label
                  ><label
                    >资料日期<input
                      v-model="data.meta.sourceDate"
                      placeholder="YYYY-MM-DD" /></label
                  ><label>设计师<input v-model="data.meta.designer" /></label
                  ><label>技术人员<input v-model="data.meta.technical" /></label
                  ><label>参考款号<input v-model="data.meta.reference" /></label
                  ><label>季节<input v-model="data.meta.season" /></label>
                </div>
                <div class="section-heading separator">
                  <h2>内部制单信息</h2>
                  <span>未提供可保留空白</span>
                </div>
                <div class="field-grid">
                  <label>订单号<input v-model="data.meta.orderNumber" /></label
                  ><label>生产工厂<input v-model="data.meta.factory" /></label
                  ><label
                    >跟单人员<input v-model="data.meta.merchandiser" /></label
                  ><label
                    >样衣数量<input
                      type="number"
                      min="0"
                      :value="data.meta.sampleQuantity ?? ''"
                      @change="
                        data.meta.sampleQuantity =
                          ($event.target as HTMLInputElement).value === ''
                            ? null
                            : Number(($event.target as HTMLInputElement).value)
                      " /></label
                  ><label
                    >发单日期<input
                      v-model="data.meta.issueDate"
                      placeholder="YYYY-MM-DD" /></label
                  ><label
                    >样品交期<input
                      v-model="data.meta.dueDate"
                      placeholder="YYYY-MM-DD"
                  /></label>
                </div>
              </div>

              <div v-if="tab === 'materials'" class="form-body">
                <div class="section-heading">
                  <h2>面料、辅料与唛头</h2>
                  <button class="text-button" @click="addMaterial">
                    ＋ 增加材料
                  </button>
                </div>
                <p class="inline-note">
                  面料逐项列出，“衬”会同步到风险评估会、耗料单和面料留卡。
                </p>
                <div
                  class="material-block"
                  v-for="(item, index) in data.materials"
                  :key="index"
                >
                  <div class="item-heading">
                    <span class="item-index">{{
                      String(index + 1).padStart(2, "0")
                    }}</span
                    ><select
                      v-model="item.kind"
                      :aria-label="`材料${index + 1}类型`"
                    >
                      <option
                        v-for="(name, id) in kindNames"
                        :key="id"
                        :value="id"
                      >
                        {{ name }}
                      </option></select
                    ><button
                      class="item-toggle"
                      @click="
                        openMaterial = openMaterial === index ? -1 : index
                      "
                      :aria-expanded="openMaterial === index"
                    >
                      <strong>{{
                        item.nameZh || item.nameEn || "未命名材料"
                      }}</strong>
                      <small>{{ item.nameEn }}</small>
                      <span>{{
                        openMaterial === index ? "−" : "+"
                      }}</span></button
                    ><button
                      class="remove"
                      :disabled="item.kind === 'interlining'"
                      @click="data.materials.splice(index, 1)"
                      :aria-label="`删除材料${index + 1}`"
                    >
                      ×
                    </button>
                  </div>
                  <div v-if="openMaterial === index" class="field-grid">
                    <label>中文名称<input v-model="item.nameZh" /></label
                    ><label>英文名称<input v-model="item.nameEn" /></label
                    ><label
                      >中文规格<textarea
                        v-model="item.specZh"
                        rows="3"
                      ></textarea></label
                    ><label
                      >英文规格<textarea
                        v-model="item.specEn"
                        rows="3"
                      ></textarea></label
                    ><label
                      >配色（每行一组）<textarea
                        :value="item.colors.join('\n')"
                        @change="
                          colors(
                            index,
                            ($event.target as HTMLTextAreaElement).value,
                          )
                        "
                        rows="2"
                      ></textarea>
                    </label>
                    <div class="field-grid">
                      <label
                        >数量<input
                          type="number"
                          :value="item.quantity ?? ''"
                          @change="
                            item.quantity =
                              ($event.target as HTMLInputElement).value === ''
                                ? null
                                : Number(
                                    ($event.target as HTMLInputElement).value,
                                  )
                          " /></label
                      ><label
                        >单位<input
                          v-model="item.unitZh"
                          placeholder="条 / 个 / 米" /></label
                      ><label class="full"
                        >英文单位<input
                          v-model="item.unitEn"
                          placeholder="PC / PCS / M"
                      /></label>
                    </div>
                    <label>中文部位<input v-model="item.placementZh" /></label
                    ><label>英文部位<input v-model="item.placementEn" /></label
                    ><label
                      >中文备注<textarea
                        v-model="item.notesZh"
                        rows="2"
                      ></textarea></label
                    ><label
                      >英文备注<textarea
                        v-model="item.notesEn"
                        rows="2"
                      ></textarea>
                    </label>
                  </div>
                </div>
              </div>

              <div v-if="tab === 'measurements'" class="form-body">
                <div class="section-heading">
                  <h2>{{ data.meta.sampleSize || "样码" }} 码尺寸表</h2>
                  <button class="text-button" @click="addMeasurement">
                    ＋ 增加尺寸
                  </button>
                </div>
                <p class="inline-note">
                  单位：{{ data.meta.unit === "inch" ? "英寸" : "厘米" }}。支持
                  12.5、12 1/2、1/8；零与空白分别保存。
                </p>
                <div class="table-scroll">
                  <table class="measure-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>英文测量部位</th>
                        <th>中文说明</th>
                        <th>尺寸</th>
                        <th>公差 ±</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="(item, index) in data.measurements"
                        :key="index"
                      >
                        <td>{{ index + 1 }}</td>
                        <td>
                          <textarea
                            v-model="item.nameEn"
                            rows="2"
                            :aria-label="`第${index + 1}项英文尺寸`"
                          ></textarea>
                        </td>
                        <td>
                          <textarea
                            v-model="item.nameZh"
                            rows="2"
                            :aria-label="`第${index + 1}项中文尺寸`"
                          ></textarea>
                        </td>
                        <td>
                          <input
                            :value="item.value ?? item.sourceValue ?? ''"
                            @change="
                              dimension(
                                index,
                                'value',
                                ($event.target as HTMLInputElement).value,
                              )
                            "
                            :aria-label="`第${index + 1}项尺寸值`"
                          />
                        </td>
                        <td>
                          <input
                            :value="item.tolerance ?? ''"
                            @change="
                              dimension(
                                index,
                                'tolerance',
                                ($event.target as HTMLInputElement).value,
                              )
                            "
                            :aria-label="`第${index + 1}项公差`"
                          />
                        </td>
                        <td>
                          <button
                            class="remove"
                            @click="data.measurements.splice(index, 1)"
                            :aria-label="`删除尺寸${index + 1}`"
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div v-if="!data.measurements.length" class="empty-state">
                  暂无尺寸项目，点击“增加尺寸”填写。
                </div>
              </div>

              <div v-if="tab === 'construction'" class="form-body">
                <div class="section-heading">
                  <h2>工艺要求</h2>
                  <button
                    class="text-button"
                    @click="
                      data.construction.push({
                        titleZh: null,
                        titleEn: null,
                        detailZh: null,
                        detailEn: null,
                      })
                    "
                  >
                    ＋ 增加工艺
                  </button>
                </div>
                <div
                  class="material-block"
                  v-for="(item, index) in data.construction"
                  :key="index"
                >
                  <div class="item-heading">
                    <span class="item-index">{{ index + 1 }}</span
                    ><strong>{{ item.titleZh || "工艺要求" }}</strong
                    ><button
                      class="remove"
                      @click="data.construction.splice(index, 1)"
                    >
                      ×
                    </button>
                  </div>
                  <div class="field-grid">
                    <label>中文部位<input v-model="item.titleZh" /></label
                    ><label>英文部位<input v-model="item.titleEn" /></label
                    ><label
                      >中文要求<textarea
                        v-model="item.detailZh"
                        rows="4"
                      ></textarea></label
                    ><label
                      >英文要求<textarea
                        v-model="item.detailEn"
                        rows="4"
                      ></textarea>
                    </label>
                  </div>
                </div>
              </div>

              <div v-if="tab === 'figures'" class="form-body">
                <div class="section-heading">
                  <h2>图片与裁剪范围</h2>
                  <button
                    class="text-button"
                    @click="addFigure"
                    :disabled="!pages.length"
                  >
                    ＋ 增加图片
                  </button>
                </div>
                <p class="inline-note">
                  从原PDF取图。裁剪范围以整页百分比填写，可调整页码和范围。
                  蓝色中文自动放在对应英文附近，导出后可在 Excel
                  中编辑、拖动文本框。
                </p>
                <div v-if="!pages.length" class="empty-state">
                  先返回导入页选择原 PDF，即可添加图片。
                </div>
                <div
                  class="figure-card"
                  v-for="(item, index) in data.figures"
                  :key="index"
                >
                  <div class="figure-image">
                    <img
                      v-if="figurePreviews[index]?.image"
                      :src="figurePreviews[index].image"
                      :alt="roleNames[item.role]"
                    />
                  </div>
                  <div class="figure-controls">
                    <div class="field-grid">
                      <label
                        >图片用途<select v-model="item.role">
                          <option
                            v-for="(name, id) in roleNames"
                            :key="id"
                            :value="id"
                          >
                            {{ name }}
                          </option>
                        </select></label
                      ><label
                        >来源页<select v-model.number="item.page">
                          <option
                            v-for="page in pages"
                            :key="page.number"
                            :value="page.number"
                          >
                            第 {{ page.number }} 页
                          </option>
                        </select></label
                      >
                    </div>
                    <div class="crop-grid">
                      <label
                        v-for="(title, key) in {
                          x: '左侧 %',
                          y: '顶部 %',
                          width: '宽度 %',
                          height: '高度 %',
                        }"
                        :key="key"
                        >{{ title
                        }}<input
                          type="number"
                          min="0"
                          max="100"
                          step="0.1"
                          :value="Number((item.box[key] * 100).toFixed(1))"
                          @change="setBox(index, key, $event)"
                      /></label>
                    </div>
                    <div class="button-row">
                      <button
                        class="text-button"
                        @click="item.box = { x: 0, y: 0, width: 1, height: 1 }"
                      >
                        取整页</button
                      ><button
                        class="text-button danger-text"
                        @click="data.figures.splice(index, 1)"
                      >
                        删除图片
                      </button>
                    </div>
                  </div>
                  <details
                    v-if="item.annotations.length"
                    class="annotation-editor"
                    :open="
                      !previewBusy &&
                      annotationReports[index].placed < item.annotations.length
                    "
                  >
                    <summary>
                      <template v-if="previewBusy">正在检查标注排版…</template>
                      <template v-else>
                        图中标注 {{ item.annotations.length }} 条 · 已翻译
                        {{ annotationReports[index].translated }} 条 · 已上图
                        {{ annotationReports[index].placed }} 条
                      </template>
                    </summary>
                    <p
                      v-if="
                        figurePreviews[index]?.figure?.annotations?.some(
                          (annotation) => annotation.placement === 'side',
                        )
                      "
                      class="inline-note"
                    >
                      原图附近空白不足的译文已放入图片右侧译文区，并保留对应英文；可放大图片逐条核对。
                    </p>
                    <p
                      v-if="
                        !previewBusy &&
                        annotationReports[index].placed <
                          item.annotations.length
                      "
                      class="annotation-warning"
                      role="alert"
                    >
                      尚有
                      {{
                        item.annotations.length -
                        annotationReports[index].placed
                      }}
                      条未完成上图。可先生成文件，再到 Excel 或 WPS 中手工修改。
                    </p>
                    <div
                      v-for="(annotation, annotationIndex) in item.annotations"
                      :key="annotationIndex"
                      class="annotation-row"
                    >
                      <span
                        v-if="!previewBusy"
                        class="annotation-state"
                        :class="
                          annotationReports[index].items[annotationIndex].status
                        "
                      >
                        {{
                          {
                            placed: "已上图",
                            unplaced: "已翻译，未上图",
                            untranslated: "缺少中文译文",
                          }[
                            annotationReports[index].items[annotationIndex]
                              .status
                          ]
                        }}
                      </span>
                      <label
                        >对应英文<textarea
                          v-model="annotation.textEn"
                          rows="2"
                        ></textarea>
                      </label>
                      <label
                        >中文译文<textarea
                          v-model="annotation.textZh"
                          rows="2"
                        ></textarea>
                      </label>
                      <button
                        class="text-button danger-text"
                        @click="item.annotations.splice(annotationIndex, 1)"
                      >
                        删除这条标注
                      </button>
                    </div>
                  </details>
                  <p v-else class="annotation-empty">
                    此图没有已识别的文字标注，请对照原图确认是否需要补充。
                  </p>
                </div>
              </div>
            </section>

            <aside class="source-panel">
              <div class="source-header">
                <strong>原始 PDF</strong
                ><span v-if="pages.length"
                  >{{ pageIndex + 1 }} / {{ pages.length }}</span
                >
              </div>
              <div v-if="activePage" class="source-image">
                <img
                  :src="activePage.image"
                  :alt="`原始PDF第${pageIndex + 1}页`"
                />
              </div>
              <div v-else class="empty-state">未选择 PDF</div>
              <div v-if="pages.length" class="page-controls">
                <button :disabled="pageIndex === 0" @click="pageIndex--">
                  ← 上一页</button
                ><select v-model.number="pageIndex" aria-label="PDF页码">
                  <option
                    v-for="(page, index) in pages"
                    :key="page.number"
                    :value="index"
                  >
                    第 {{ page.number }} 页
                  </option></select
                ><button
                  :disabled="pageIndex === pages.length - 1"
                  @click="pageIndex++"
                >
                  下一页 →
                </button>
              </div>
              <div class="missing-panel">
                <span class="eyebrow">待确认 {{ missing.length }} 项</span>
                <p v-for="(item, index) in missing.slice(0, 10)" :key="index">
                  {{ item }}
                </p>
                <small v-if="missing.length > 10"
                  >另有 {{ missing.length - 10 }} 项，可在资料中核对。</small
                >
                <p v-if="!missing.length" class="muted">
                  当前没有列出的缺失项目，仍请核对原资料。
                </p>
              </div>
            </aside>
          </div>
          <div class="bottom-action sticky">
            <div>
              <strong>{{ busy ? status : "核对完成后，生成新 Excel" }}</strong
              ><small
                >原模板和原 PDF 均不会被覆盖。已新增
                {{ fabrics }} 项面料及衬的对应信息。</small
              >
            </div>
            <div class="button-row">
              <button class="secondary" @click="step = 1" :disabled="busy">
                返回导入</button
              ><button class="primary" @click="exportWorkbook" :disabled="busy">
                <span v-if="busy" class="spinner"></span
                >{{ busy ? "正在生成…" : "生成 Excel 制单" }}
                <span v-if="!busy">→</span>
              </button>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="page-heading">
            <div>
              <span class="eyebrow">03 / 导出</span>
              <h1>{{ result ? "新制单已生成" : "准备导出制单" }}</h1>
              <p>
                CAD
                相关页和尺寸页中英对照，其余填写中文。打样页总计下方说明、邮件页和风险指导原文保持模板内容。
              </p>
            </div>
          </div>
          <section class="export-card">
            <div class="export-icon">✓</div>
            <h2>{{ result?.name || "请先完成资料核对" }}</h2>
            <p>{{ result?.path || "返回核对页后点击“生成 Excel 制单”。" }}</p>
            <div class="export-actions">
              <button
                v-if="result"
                class="primary"
                @click="action(() => api.openExport(result!.path, false))"
              >
                打开 Excel</button
              ><button
                v-if="result"
                class="secondary"
                @click="action(() => api.openExport(result!.path, true))"
              >
                打开所在文件夹</button
              ><button class="text-button" @click="step = 2">
                继续修改资料
              </button>
            </div>
          </section>
          <div class="bottom-action">
            <div>
              <strong>这份资料已可继续修改</strong
              ><small>保存资料后，可以再次导入，无需重新识别。</small>
            </div>
            <div class="button-row">
              <button class="secondary" @click="saveData">保存资料</button
              ><button class="primary" @click="step = 1">
                处理下一份资料 →
              </button>
            </div>
          </div>
        </template>
      </div>
    </main>

    <div
      v-if="settingsOpen"
      class="modal-backdrop"
      @click.self="settingsOpen = false"
    >
      <section
        class="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div class="modal-header">
          <div>
            <span class="eyebrow">设置</span>
            <h2 id="settings-title">模型与 API</h2>
          </div>
          <button
            class="remove"
            @click="settingsOpen = false"
            aria-label="关闭设置"
          >
            ×
          </button>
        </div>
        <p class="modal-description">
          识别 PDF 和翻译时使用此服务。模板填写、图片处理和 Excel
          导出在本机完成。其他电脑需自行配置模型服务，连接跟随系统代理。
        </p>
        <div v-if="error" class="alert error" role="alert">{{ error }}</div>
        <label
          >接口类型<select v-model="settings.protocol">
            <option value="responses">OpenAI Responses</option>
            <option value="chat">OpenAI 兼容 / Chat Completions</option>
          </select></label
        ><label
          >API 基础地址<input
            v-model="settings.baseUrl"
            placeholder="https://api.openai.com/v1"
          /><small>兼容服务或本地模型可填写自己的 /v1 地址。</small></label
        ><label
          >模型名称<input
            v-model="settings.model"
            placeholder="gpt-6.1-sol"
          /><small
            >需要支持图片输入；推荐使用支持结构化输出的模型。</small
          ></label
        ><label
          >推理强度<select v-model="settings.reasoningEffort">
            <option value="default">跟随服务默认</option>
            <option value="low">low（低）</option>
            <option value="medium">medium（中等）</option>
            <option value="high">high（高）</option>
            <option value="xhigh">xhigh（超高，默认）</option></select
          ><small
            >默认使用
            xhigh。较高强度通常耗时更长、消耗更多，需要模型支持。</small
          ></label
        ><label
          >API Key<input
            type="password"
            v-model="keyInput"
            :placeholder="
              settings.hasApiKey
                ? '已保存；留空保持原 Key'
                : '填写服务商提供的 API Key'
            "
            autocomplete="off" /></label
        ><label class="check-label"
          ><input
            type="checkbox"
            v-model="settings.rememberKey"
          />使用系统加密记住 API Key</label
        ><label v-if="settings.hasApiKey" class="check-label"
          ><input type="checkbox" v-model="clearKey" />清除已保存的 API
          Key</label
        >
        <p class="hint">
          Key 不会写入导出的 Excel
          或资料文件。使用自己的模型服务，费用按服务商规则计算。
        </p>
        <section class="cache-settings">
          <h3>缓存与本机数据</h3>
          <label
            >识别缓存目录<input
              aria-label="识别缓存目录"
              :value="cacheSettings.directory"
              readonly
          /></label>
          <div class="cache-actions">
            <button
              class="secondary"
              @click="changeCache('choose')"
              :disabled="busy || cacheBusy"
            >
              更改位置
            </button>
            <button
              class="text-button"
              @click="changeCache('reset')"
              :disabled="
                busy ||
                cacheBusy ||
                cacheSettings.directory === cacheSettings.defaultDirectory
              "
            >
              恢复默认
            </button>
            <button
              class="text-button"
              @click="changeCache('clear')"
              :disabled="busy || cacheBusy"
            >
              清除缓存
            </button>
          </div>
          <p class="hint">
            默认缓存在安装目录下的 techpack-studio-cache
            文件夹。更改位置后使用新目录；卸载会删除所有用过的专用缓存目录及 API
            配置。
          </p>
          <p v-if="cacheMessage" class="cache-message" role="status">
            {{ cacheMessage }}
          </p>
          <template v-if="api.platform === 'darwin'">
            <button
              class="text-button uninstall-button"
              @click="uninstallApp"
              :disabled="busy || cacheBusy"
            >
              卸载并清除本机数据
            </button>
            <p class="hint">
              Mac 使用此入口退出并删除程序、专用缓存和本机配置。
            </p>
          </template>
        </section>
        <div class="modal-actions">
          <button class="secondary" @click="settingsOpen = false">取消</button
          ><button
            class="primary"
            @click="saveSettings"
            :disabled="savingSettings"
          >
            {{ savingSettings ? "保存中…" : "保存设置" }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
