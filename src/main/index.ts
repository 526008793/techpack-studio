import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
} from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  techPackSchema,
  type ApiSettings,
  type SelectedFile,
  type PdfPage,
  type FigureImage,
} from "../shared/model";
import { extractTechPack } from "./ai";
import { SettingsStore, cacheKey, readCache, writeCache } from "./storage";
import { generateWorkbook, inspectTemplate } from "./workbook";
import { readTemplateFile } from "./convert";

const here = path.dirname(fileURLToPath(import.meta.url));
const resources = app.isPackaged
  ? path.join(process.resourcesPath, "resources")
  : path.resolve(here, "../../resources");
if (process.env.TECHPACK_USER_DATA)
  app.setPath("userData", process.env.TECHPACK_USER_DATA);
let window: BrowserWindow | null = null,
  settings: SettingsStore;
const files = new Map<string, SelectedFile>(),
  templates = new Map<string, Buffer>(),
  exports = new Set<string>();
let controller: AbortController | null = null;
const send = (text: string) =>
  window?.webContents.send("techpack:progress", text);

function handle(name: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle("techpack:" + name, async (event, ...args) => {
    const frame = event.senderFrame?.url || "";
    const trusted =
      window &&
      event.sender === window.webContents &&
      (frame.startsWith("file:") ||
        (!app.isPackaged &&
          frame.startsWith(
            process.env.ELECTRON_RENDERER_URL || "http://localhost:5173",
          )));
    if (!trusted) throw new Error("不允许的调用来源");
    try {
      return await fn(...args);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "操作未完成");
    }
  });
}
async function pdfFile(file: string): Promise<SelectedFile> {
  const bytes = await fs.readFile(file);
  if (bytes.subarray(0, 5).toString() !== "%PDF-")
    throw new Error("这不是有效的PDF文件");
  const result = {
    id: randomUUID(),
    name: path.basename(file),
    path: file,
    bytes: new Uint8Array(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  files.set(result.id, result);
  return result;
}
function register() {
  handle("choose-pdf", async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: "选择新收到的PDF资料",
      filters: [{ name: "PDF资料", extensions: ["pdf"] }],
      properties: ["openFile"],
    });
    return result.canceled ? null : pdfFile(result.filePaths[0]);
  });
  handle("choose-template", async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: "选择同格式Excel模板",
      filters: [{ name: "Excel模板", extensions: ["xlsx", "xls"] }],
      properties: ["openFile"],
    });
    if (result.canceled) return null;
    const bytes = await readTemplateFile(result.filePaths[0]);
    const sheets = await inspectTemplate(bytes),
      id = randomUUID();
    templates.set(id, bytes);
    return { id, name: path.basename(result.filePaths[0]), sheets };
  });
  handle("settings", () => settings.public());
  handle("save-settings", (next: ApiSettings) => settings.save(next));
  handle("cancel-analysis", () => {
    controller?.abort();
  });
  handle(
    "analyze",
    async (request: { fileId: string; pages: PdfPage[]; force: boolean }) => {
      const file = files.get(request.fileId);
      if (!file) throw new Error("请重新选择PDF文件");
      if (controller) throw new Error("已有资料正在识别，请等待完成或取消。");
      const config = settings.privateSettings(),
        key = cacheKey(file.sha256, config);
      if (!request.force) {
        const cached = await readCache(app.getPath("userData"), key);
        if (cached) {
          send("已读取本地识别缓存");
          return { data: cached, cached: true };
        }
      }
      controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), 10 * 60 * 1000);
      try {
        send("正在识别资料、尺寸和图片，并整理中英对照…");
        const data = await extractTechPack(
          config,
          request.pages,
          controller.signal,
        );
        await writeCache(app.getPath("userData"), key, data);
        send("识别完成，请核对资料");
        return { data, cached: false };
      } finally {
        clearTimeout(timer);
        controller = null;
      }
    },
  );
  handle(
    "export",
    async (request: {
      data: unknown;
      templateId: string | null;
      figures: FigureImage[];
    }) => {
      const data = techPackSchema.parse(request.data);
      const template = request.templateId
        ? templates.get(request.templateId)
        : await fs.readFile(path.join(resources, "template.xlsx"));
      if (!template) throw new Error("自定义模板已失效，请重新选择");
      const filename =
        `【中英对照制单】${[data.meta.styleNumber, data.meta.styleName].filter(Boolean).join(" ") || "新款"}.xlsx`.replace(
          /[<>:"/\\|?*\x00-\x1f]/g,
          "_",
        );
      const result = await dialog.showSaveDialog(window!, {
        title: "保存新制单",
        defaultPath: path.join(app.getPath("documents"), filename),
        filters: [{ name: "Excel工作簿", extensions: ["xlsx"] }],
      });
      if (result.canceled || !result.filePath) return null;
      send("正在填写模板、替换图片并设置A4单页打印…");
      const output = await generateWorkbook(template, data, request.figures);
      const temp = result.filePath + ".tmp";
      await fs.writeFile(temp, output.buffer);
      await fs.rename(temp, result.filePath);
      exports.add(result.filePath);
      send("Excel已生成");
      return {
        path: result.filePath,
        name: path.basename(result.filePath),
        sheets: output.sheets,
        warnings: output.warnings,
      };
    },
  );
  handle("open-export", async (file: string, folder: boolean) => {
    if (!exports.has(file)) throw new Error("只能打开本次导出的文件");
    if (folder) shell.showItemInFolder(file);
    else {
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
    }
  });
  handle("sample", async () => ({
    file: await pdfFile(path.join(resources, "example.pdf")),
    data: techPackSchema.parse(
      JSON.parse(
        await fs.readFile(path.join(resources, "example.json"), "utf8"),
      ),
    ),
  }));
  handle("load-data", async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: "导入已保存的制单资料",
      filters: [{ name: "制单资料", extensions: ["json"] }],
      properties: ["openFile"],
    });
    return result.canceled
      ? null
      : techPackSchema.parse(
          JSON.parse(await fs.readFile(result.filePaths[0], "utf8")),
        );
  });
  handle("save-data", async (data: unknown) => {
    const validated = techPackSchema.parse(data);
    const result = await dialog.showSaveDialog(window!, {
      title: "保存识别结果，方便以后继续修改",
      defaultPath: (validated.meta.styleNumber || "制单资料") + ".json",
      filters: [{ name: "制单资料", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, JSON.stringify(validated, null, 2));
    return result.filePath;
  });
}
function createWindow() {
  window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1080,
    minHeight: 740,
    title: "制单助手",
    icon: path.join(resources, "app-icon.png"),
    backgroundColor: "#f5f5f0",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (
      !url.startsWith("file:") &&
      !(
        process.env.ELECTRON_RENDERER_URL &&
        url.startsWith(process.env.ELECTRON_RENDERER_URL)
      )
    )
      event.preventDefault();
  });
  window.on("closed", () => {
    window = null;
    controller?.abort();
  });
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(path.join(here, "../renderer/index.html"));
}
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.whenReady().then(async () => {
    // Match the installer shortcuts so Windows groups the taskbar under this app.
    if (process.platform === "win32")
      app.setAppUserModelId("local.techpack.studio");
    settings = new SettingsStore(app.getPath("userData"), safeStorage);
    try {
      await settings.load();
    } catch (error) {
      dialog.showErrorBox(
        "模型设置",
        error instanceof Error ? error.message : "设置读取失败",
      );
    }
    register();
    createWindow();
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
