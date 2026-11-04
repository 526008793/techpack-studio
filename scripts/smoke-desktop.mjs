import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { _electron } from "playwright-core";
import electronPath from "electron";
import JSZip from "jszip";

const root = process.cwd(),
  output = path.join(root, "output/playwright");
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "techpack-desktop-"));
const install = await fs.mkdtemp(
  path.join(os.tmpdir(), "techpack-desktop-install-"),
);
await fs.copyFile(
  path.join(root, "package.json"),
  path.join(install, "package.json"),
);
for (const name of ["out", "resources", "node_modules"])
  await fs.symlink(path.join(root, name), path.join(install, name));
const cacheRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "techpack-custom-cache-"),
);
const example = JSON.parse(
  await fs.readFile(path.join(root, "resources/example.json"), "utf8"),
);
let requests = 0;
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(req.url, "http://techpack-proxy.invalid/v1/responses");
    assert.equal(req.headers.authorization, "Bearer local-test-only");
    assert.equal(body.store, false);
    assert.deepEqual(body.reasoning, { effort: "xhigh" });
    assert.equal(
      body.input[1].content.filter((x) => x.type === "input_image").length,
      7,
    );
    requests++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(example) }],
          },
        ],
      }),
    );
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port,
  errors = [];
const env = { ...process.env, TECHPACK_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
try {
  app = await _electron.launch({
    executablePath: electronPath,
    args: [install, "--use-mock-keychain"],
    cwd: root,
    env,
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.getByRole("heading", { name: "开始一份新制单" }).waitFor();
  await page.getByRole("img", { name: "ZHH", exact: true }).waitFor();
  await page.waitForFunction(() => {
    const image = document.querySelector(".brand-icon");
    return image?.complete && image.naturalWidth === 1024;
  });
  const icon = await app.evaluate(({ app, nativeImage }) => ({
    version: app.getVersion(),
    empty: nativeImage
      .createFromPath(app.getAppPath() + "/resources/app-icon.png")
      .isEmpty(),
  }));
  assert.equal(icon.empty, false);
  assert.match(
    await page.locator(".sidebar-bottom").innerText(),
    new RegExp(`v${icon.version.replaceAll(".", "\\.")}`),
  );
  await page.screenshot({ path: path.join(output, "01-import.png") });

  assert.equal(
    await page.getByRole("list", { name: "已保存的模板规则" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "新增模板规则" }).count(),
    0,
  );

  const incompatiblePath = path.join(output, "reduced-template.xlsx");
  const incompatibleZip = await JSZip.loadAsync(
    await fs.readFile(path.join(root, "resources/template.xlsx")),
  );
  const originalBook = await incompatibleZip
    .file("xl/workbook.xml")
    .async("string");
  const withoutCad = originalBook.replace(
    /<sheet\b[^>]*\bname="CAD"[^>]*\/>/,
    "",
  );
  assert.notEqual(withoutCad, originalBook);
  incompatibleZip.file("xl/workbook.xml", withoutCad);
  await fs.writeFile(
    incompatiblePath,
    await incompatibleZip.generateAsync({ type: "nodebuffer" }),
  );
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, incompatiblePath);
  await page.getByRole("button", { name: "选择其他模板", exact: true }).click();
  await page.getByText("自定义模板 · 10 个工作表", { exact: true }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  await page.screenshot({
    path: path.join(output, "01-variable-template.png"),
  });
  await page.getByRole("button", { name: "使用内置模板", exact: true }).click();
  await page.getByText("内置 11 页模板", { exact: true }).waitFor();
  await app.evaluate(
    ({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    },
    path.join(root, "resources/template.xlsx"),
  );
  await page.getByRole("button", { name: "选择其他模板", exact: true }).click();
  await page
    .getByRole("heading", { name: "template.xlsx", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "使用内置模板", exact: true }).click();
  await page.getByText("内置 11 页模板", { exact: true }).waitFor();
  assert.equal(requests, 0, "template selection does not call a model");

  // The fake hostname cannot resolve directly: only Chromium's configured proxy can reach this server.
  await app.evaluate(
    ({ session }, proxyPort) =>
      session.defaultSession.setProxy({
        mode: "fixed_servers",
        proxyRules: `http=127.0.0.1:${proxyPort}`,
      }),
    port,
  );

  await page
    .getByRole("button", { name: "模型与 API 设置", exact: false })
    .click();
  const settings = page.getByRole("dialog");
  assert.equal(await settings.getByLabel("推理强度").inputValue(), "xhigh");
  assert.equal(
    await settings.getByLabel("识别缓存目录").inputValue(),
    path.join(install, "techpack-studio-cache"),
  );
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
  }, cacheRoot);
  await settings.getByRole("button", { name: "更改位置", exact: true }).click();
  await settings
    .getByText("缓存位置已保存，立即生效。", { exact: true })
    .waitFor();
  assert.equal(
    await settings.getByLabel("识别缓存目录").inputValue(),
    path.join(cacheRoot, "techpack-studio-cache"),
  );

  await settings
    .getByLabel("API 基础地址")
    .fill("http://techpack-proxy.invalid/v1");
  await settings.getByLabel("模型名称").fill("mock-vision");
  await settings.getByLabel("API Key", { exact: true }).fill("local-test-only");
  await settings.getByLabel("使用系统加密记住 API Key").uncheck();
  await page.screenshot({ path: path.join(output, "02-settings.png") });
  await settings.getByRole("button", { name: "保存设置", exact: true }).click();
  await settings.waitFor({ state: "hidden" });
  const safeSettings = await page.evaluate(() => window.techpack.settings());
  assert.equal(safeSettings.apiKey, undefined);
  assert.equal(safeSettings.hasApiKey, true);
  assert.equal(safeSettings.reasoningEffort, "xhigh");
  await app.evaluate(
    ({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    },
    path.join(root, "resources/example.pdf"),
  );
  await page
    .getByRole("button", { name: "选择 PDF 文件", exact: false })
    .click();
  await page
    .getByText("已读取 7 页", { exact: true })
    .waitFor({ timeout: 60000 });
  await page
    .getByRole("button", { name: "识别并整理资料", exact: false })
    .click();
  await page
    .getByRole("heading", { name: "P4541 RANDY", exact: true })
    .waitFor({ timeout: 60000 });
  assert.equal(requests, 1);
  await page.screenshot({ path: path.join(output, "03-review.png") });
  await page.getByRole("tab", { name: "面辅料", exact: true }).click();
  assert.equal(await page.locator(".material-block").count(), 15);
  assert.equal(
    await page
      .locator(".material-block .item-heading select")
      .evaluateAll(
        (items) => items.filter((item) => item.value === "interlining").length,
      ),
    1,
  );
  await page.screenshot({ path: path.join(output, "04-materials.png") });
  await page.getByRole("tab", { name: "尺寸表", exact: true }).click();
  assert.equal(await page.locator(".measure-table tbody tr").count(), 23);
  await page
    .getByRole("textbox", { name: "第1项尺寸值", exact: true })
    .fill("16 1/4");
  await page.getByRole("textbox", { name: "第1项公差", exact: true }).click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "第1项尺寸值", exact: true })
      .inputValue(),
    "16.25",
  );
  await page.screenshot({ path: path.join(output, "05-measurements.png") });
  await page.getByRole("tab", { name: "图片参考", exact: true }).click();
  assert.equal(await page.locator(".figure-card").count(), 5);
  await page.locator(".annotation-editor summary").click();
  assert.equal(await page.getByLabel("中文译文", { exact: true }).count(), 9);
  await page
    .getByLabel("中文译文", { exact: true })
    .nth(6)
    .fill("面料1（可编辑）");
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".figure-image img")].length === 5 &&
      [...document.querySelectorAll(".figure-image img")].every(
        (img) => img.complete && img.naturalWidth > 0,
      ),
  );
  await page.screenshot({ path: path.join(output, "06-figures.png") });
  const preview = await page
    .locator(".figure-card")
    .nth(1)
    .locator(".figure-image img")
    .getAttribute("src");
  await fs.writeFile(
    path.join(output, "cad-annotation-preview.png"),
    Buffer.from(preview.split(",")[1], "base64"),
  );
  const destination = path.join(output, "full-flow.xlsx");
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, destination);
  await page
    .getByRole("button", { name: "生成 Excel 制单", exact: false })
    .click();
  await page
    .getByRole("heading", { name: "新制单已生成", exact: true })
    .waitFor({ timeout: 60000 });
  await page.screenshot({ path: path.join(output, "07-export.png") });
  const zip = await JSZip.loadAsync(await fs.readFile(destination));
  const drawingText = (
    await Promise.all(
      Object.keys(zip.files)
        .filter((name) => /^xl\/drawings\/tp-.*\.xml$/.test(name))
        .map((name) => zip.file(name).async("string")),
    )
  ).join("\n");
  assert.match(drawingText.replace(/<[^>]+>/g, ""), /面料1（可编辑）/);
  assert.ok([...drawingText.matchAll(/txBox="1"/g)].length >= 5);
  assert.match(
    await zip.file("xl/worksheets/sheet7.xml").async("string"),
    /<v>16\.25<\/v>/,
  );
  assert.ok(
    Object.keys(zip.files).filter((n) => n.startsWith("xl/media/tp-")).length >=
      8,
    "fresh PDF source images were embedded",
  );
  assert.doesNotMatch(
    await zip.file("xl/worksheets/sheet6.xml").async("string"),
    /S260954|P4507|邹双双|ADTN-Wallance/,
  );
  await page.getByRole("button", { name: "继续修改资料", exact: true }).click();
  await page.getByRole("button", { name: "返回导入", exact: true }).click();
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, incompatiblePath);
  await page.getByRole("button", { name: "选择其他模板", exact: true }).click();
  await page.getByText("自定义模板 · 10 个工作表", { exact: true }).waitFor();
  await page.locator("nav.steps button").nth(1).click();
  const customDestination = path.join(output, "reduced-template-output.xlsx");
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, customDestination);
  await page
    .getByRole("button", { name: "生成 Excel 制单", exact: false })
    .click();
  await page
    .getByRole("heading", { name: "新制单已生成", exact: true })
    .waitFor({ timeout: 60000 });
  assert.equal(await page.locator(".print-summary").count(), 0);
  assert.equal(
    await page.getByRole("heading", { name: "需要核对的项目" }).count(),
    0,
  );
  const customZip = await JSZip.loadAsync(await fs.readFile(customDestination));
  assert.equal(
    [
      ...(await customZip.file("xl/workbook.xml").async("string")).matchAll(
        /<sheet\b/g,
      ),
    ].length,
    10,
  );
  assert.doesNotMatch(
    await customZip.file("xl/workbook.xml").async("string"),
    /name="CAD"/,
  );
  assert.equal(
    requests,
    1,
    "adapting a custom template is local and does not call the model again",
  );
  await page
    .getByRole("button", { name: "处理下一份资料", exact: false })
    .click();
  await page
    .getByRole("button", { name: "识别并整理资料", exact: false })
    .click();
  await page
    .getByRole("heading", { name: "P4541 RANDY", exact: true })
    .waitFor();
  assert.equal(requests, 1, "same PDF uses the local extraction cache");
  await page.getByRole("button", { name: "返回导入", exact: true }).click();
  await page
    .getByRole("button", { name: "查看 P4541 示例", exact: false })
    .click();
  await page
    .getByRole("heading", { name: "P4541 RANDY", exact: true })
    .waitFor();
  assert.equal(requests, 1, "reviewed example does not call a cloud model");
  await page.getByRole("button", { name: "返回导入", exact: true }).click();
  await page
    .getByRole("button", { name: "模型与 API 设置", exact: false })
    .click();
  const customDirectory = path.join(cacheRoot, "techpack-studio-cache");
  await fs.writeFile(path.join(customDirectory, "keep-me.json"), "unrelated");
  await settings.getByRole("button", { name: "清除缓存", exact: true }).click();
  await settings
    .getByText("已清理 1 个缓存文件，下次识别会重新调用 AI。", { exact: true })
    .waitFor();
  assert.equal(
    await fs.readFile(path.join(customDirectory, "keep-me.json"), "utf8"),
    "unrelated",
  );
  await settings.getByRole("button", { name: "取消", exact: true }).click();
  await page
    .getByRole("button", { name: "识别并整理资料", exact: false })
    .click();
  await page
    .getByRole("heading", { name: "P4541 RANDY", exact: true })
    .waitFor();
  assert.equal(
    requests,
    2,
    "clearing cache causes the same PDF to call the model again",
  );
  await page
    .getByRole("button", { name: "模型与 API 设置", exact: false })
    .click();
  await settings.getByRole("button", { name: "恢复默认", exact: true }).click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[aria-label="识别缓存目录"]').value === expected,
    path.join(install, "techpack-studio-cache"),
  );
  await settings.getByRole("button", { name: "取消", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        modelRequests: requests,
        modelViaChromiumProxy: true,
        pdfPages: 7,
        measurements: 23,
        materials: 15,
        figures: 5,
        export: destination,
        screenshots: output,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(output, "failure.png") });
    console.error((await page.locator("body").innerText()).slice(-6000));
  }
  console.error("Renderer errors:", errors);
  throw error;
} finally {
  if (app) await app.close();
  server.close();
  await fs.rm(profile, { recursive: true, force: true });
  await fs.rm(install, { recursive: true, force: true });
  await fs.rm(cacheRoot, { recursive: true, force: true });
}
