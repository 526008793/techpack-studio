import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  safeStorage,
  shell,
} from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  techPackSchema,
  type ApiSettings,
  type SelectedFile,
  type PdfPage,
  type FigureImage,
} from "../shared/model";
import { extractTechPack } from "./ai";
import { SettingsStore, cacheKey, readCache, writeCache } from "./storage";
import {
  generateWorkbook,
  generateTemplateWorkbook,
  inspectTemplate,
} from "./workbook";
import { readTemplateFile } from "./convert";
import { CacheStore } from "./cache";

const here = path.dirname(fileURLToPath(import.meta.url));
const resources = app.isPackaged
  ? path.join(process.resourcesPath, "resources")
  : path.resolve(here, "../../resources");
if (process.env.TECHPACK_USER_DATA)
  app.setPath("userData", process.env.TECHPACK_USER_DATA);
let window: BrowserWindow | null = null,
  settings: SettingsStore,
  cache: CacheStore;
const files = new Map<string, SelectedFile>(),
  templates = new Map<string, Buffer>(),
  exports = new Set<string>();
let controller: AbortController | null = null;
let changingCache = false;
const send = (text: string) =>
  window?.webContents.send("techpack:progress", text);

async function manageCache<T>(operation: () => Promise<T>): Promise<T> {
  if (controller || changingCache)
    throw new Error("请先等待识别或缓存操作完成。");
  changingCache = true;
  try {
    return await operation();
  } finally {
    changingCache = false;
  }
}

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
      title: "选择Excel制单模板",
      filters: [{ name: "Excel模板", extensions: ["xlsx", "xls"] }],
      properties: ["openFile"],
    });
    if (result.canceled) return null;
    const name = path.basename(result.filePaths[0]);
    try {
      const bytes = await readTemplateFile(
        result.filePaths[0],
        app.isPackaged
          ? process.platform === "darwin"
            ? path.join(
                process.resourcesPath,
                "converter/LibreOffice.app/Contents/MacOS/soffice",
              )
            : process.platform === "win32"
              ? path.join(
                  process.resourcesPath,
                  "converter/LibreOffice/program/soffice.exe",
                )
              : undefined
          : undefined,
      );
      const sheets = await inspectTemplate(bytes),
        id = randomUUID();
      templates.set(id, bytes);
      return { id, name, sheets };
    } catch (error) {
      throw new Error(
        `无法使用自定义模板“${name}”：${error instanceof Error ? error.message : String(error)} 当前模板未更换，可点击“使用内置模板”继续。`,
      );
    }
  });
  handle("settings", () => settings.public());
  handle("save-settings", (next: ApiSettings) => settings.save(next));
  handle("cache-settings", () => cache.public());
  handle("choose-cache-directory", () =>
    manageCache(async () => {
      const result = await dialog.showOpenDialog(window!, {
        title: "选择缓存保存位置（会创建专用子目录）",
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled
        ? null
        : cache.changeDirectory(
            path.join(result.filePaths[0], "techpack-studio-cache"),
          );
    }),
  );
  handle("reset-cache-directory", () =>
    manageCache(() => cache.changeDirectory(cache.defaultDirectory)),
  );
  handle("clear-cache", () => manageCache(() => cache.clearCurrent()));
  handle("uninstall-app", () =>
    manageCache(async () => {
      if (process.platform !== "darwin" || !app.isPackaged)
        throw new Error("请通过系统的应用卸载入口卸载安装版本。");
      const choice = await dialog.showMessageBox(window!, {
        type: "warning",
        message: "卸载制单助手并清除本机数据？",
        detail:
          "将删除程序、全部专用缓存目录、日志、API Key 和模型配置。已导出的 Excel 和自行保存的资料文件会保留。",
        buttons: ["取消", "卸载并清除"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (choice.response !== 1) return;
      await cache.clearAll();
      const bundle = path.dirname(path.dirname(path.dirname(process.execPath)));
      // 由独立进程等待退出后清除，避免 Chromium 重建配置或残留正在使用的文件。
      const cleanup = spawn(
        "/bin/sh",
        [
          "-c",
          'while kill -0 "$1" 2>/dev/null; do sleep 0.1; done\n/bin/rm -rf -- "$2" "$3" "$4"',
          "techpack-uninstall",
          String(process.pid),
          bundle,
          app.getPath("userData"),
          app.getPath("logs"),
        ],
        { detached: true, stdio: "ignore" },
      );
      await new Promise<void>((resolve, reject) => {
        cleanup.once("spawn", resolve);
        cleanup.once("error", reject);
      });
      cleanup.unref();
      app.exit(0);
    }),
  );
  handle("cancel-analysis", () => {
    controller?.abort();
  });
  handle(
    "analyze",
    async (request: { fileId: string; pages: PdfPage[]; force: boolean }) => {
      const file = files.get(request.fileId);
      if (!file) throw new Error("请重新选择PDF文件");
      if (controller || changingCache)
        throw new Error("已有任务正在处理，请等待完成或取消。");
      const config = settings.privateSettings(),
        key = cacheKey(file.sha256, config);
      if (!request.force) {
        const cached = await readCache(cache.directory, key);
        if (cached) {
          send("已读取本地识别缓存");
          return { data: cached, cached: true };
        }
      }
      controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(
        () => {
          timedOut = true;
          controller?.abort();
        },
        10 * 60 * 1000,
      );
      try {
        send("正在识别资料、尺寸和图片，并整理中英对照…");
        const data = await extractTechPack(
          config,
          request.pages,
          controller.signal,
          // 使用 Chromium 网络栈，跟随 Windows 等系统的代理配置。
          (url, options) => net.fetch(url, options),
        );
        await writeCache(cache.directory, key, data);
        send("识别完成，请核对资料");
        return { data, cached: false };
      } catch (error) {
        if (timedOut)
          throw new Error(
            "本次识别超过程序的 10 分钟等待时间。可以重试，或在模型设置中调整推理强度；本次失败未写入缓存。",
          );
        throw error;
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
      send("正在填写模板、替换图片并整理 Excel 页面…");
      const output = request.templateId
        ? await generateTemplateWorkbook(template, data, request.figures)
        : await generateWorkbook(template, data, request.figures);
      const temp = result.filePath + ".tmp";
      await fs.writeFile(temp, output.buffer);
      await fs.rename(temp, result.filePath);
      exports.add(result.filePath);
      send("Excel已生成");
      return {
        path: result.filePath,
        name: path.basename(result.filePath),
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
    const installDirectory = app.isPackaged
      ? process.platform === "darwin"
        ? path.resolve(process.execPath, "../../../..")
        : path.dirname(process.execPath)
      : app.getAppPath();
    cache = new CacheStore(app.getPath("userData"), installDirectory);
    try {
      await settings.load();
      await cache.load();
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
