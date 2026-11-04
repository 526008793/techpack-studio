import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
const run = promisify(execFile);

export async function readTemplateFile(
  file: string,
  bundledConverter?: string,
): Promise<Buffer> {
  if (path.extname(file).toLowerCase() === ".xlsx") return fs.readFile(file);
  if (path.extname(file).toLowerCase() !== ".xls")
    throw new Error("请选择 .xlsx 或 .xls 制单模板");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "techpack-template-"));
  try {
    const copied = path.join(dir, "template.xls");
    await fs.copyFile(file, copied);
    // 安装包携带对应平台的本地转换组件；优先使用随App移动的相对资源路径。
    const candidates = [
      ...(bundledConverter ? [bundledConverter] : []),
      ...(process.platform === "win32"
        ? [
            path.join(
              process.env.ProgramFiles || "C:\\Program Files",
              "LibreOffice",
              "program",
              "soffice.exe",
            ),
            path.join(
              process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
              "LibreOffice",
              "program",
              "soffice.exe",
            ),
          ]
        : process.platform === "darwin"
          ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
          : ["/usr/bin/libreoffice"]),
    ];
    for (const executable of candidates) {
      try {
        await fs.access(executable);
      } catch {
        continue;
      }
      console.info("[template:convert]", {
        extension: ".xls",
        converter: executable === bundledConverter ? "bundled" : "installed",
      });
      await run(
        executable,
        [
          `-env:UserInstallation=${pathToFileURL(path.join(dir, "profile")).href}`,
          "--headless",
          "--convert-to",
          "xlsx",
          "--outdir",
          dir,
          copied,
        ],
        { timeout: 90000, windowsHide: true },
      );
      return await fs.readFile(path.join(dir, "template.xlsx"));
    }
    if (process.platform === "win32") {
      // File paths are passed as environment values, never interpolated as PowerShell code.
      const script =
        "$ErrorActionPreference='Stop'; $excel=New-Object -ComObject Excel.Application; $excel.Visible=$false; $excel.DisplayAlerts=$false; $excel.AutomationSecurity=3; $book=$null; try { $book=$excel.Workbooks.Open($env:TECHPACK_XLS_SOURCE); $book.SaveAs($env:TECHPACK_XLS_TARGET,51) } finally { if($book){$book.Close($false)}; $excel.Quit(); [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null }";
      try {
        await run(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          {
            env: {
              ...process.env,
              TECHPACK_XLS_SOURCE: copied,
              TECHPACK_XLS_TARGET: path.join(dir, "template.xlsx"),
            },
            timeout: 90000,
            windowsHide: true,
          },
        );
        return await fs.readFile(path.join(dir, "template.xlsx"));
      } catch {
        throw new Error(
          "旧版 .xls 模板需要已安装的 Microsoft Excel 或 LibreOffice 转换。也可以用 WPS 将模板另存为 .xlsx，或直接选择内置模板。",
        );
      }
    }
    throw new Error(
      "本地 XLS 转换组件未找到，请重新安装包含转换组件的制单助手，或选择 .xlsx 模板。",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
