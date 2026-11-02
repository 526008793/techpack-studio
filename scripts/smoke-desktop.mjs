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
const example = JSON.parse(
  await fs.readFile(path.join(root, "resources/example.json"), "utf8"),
);
let requests = 0;
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.headers.authorization, "Bearer local-test-only");
    assert.equal(body.store, false);
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
    args: [".", "--use-mock-keychain"],
    cwd: root,
    env,
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.getByRole("heading", { name: "开始一份新制单" }).waitFor();
  await page.screenshot({ path: path.join(output, "01-import.png") });

  await page
    .getByRole("button", { name: "模型与 API 设置", exact: false })
    .click();
  const settings = page.getByRole("dialog");
  await settings.getByLabel("API 基础地址").fill(`http://127.0.0.1:${port}/v1`);
  await settings.getByLabel("模型名称").fill("mock-vision");
  await settings.getByLabel("API Key", { exact: true }).fill("local-test-only");
  await settings.getByLabel("使用系统加密记住 API Key").uncheck();
  await page.screenshot({ path: path.join(output, "02-settings.png") });
  await settings.getByRole("button", { name: "保存设置", exact: true }).click();
  await settings.waitFor({ state: "hidden" });
  const safeSettings = await page.evaluate(() => window.techpack.settings());
  assert.equal(safeSettings.apiKey, undefined);
  assert.equal(safeSettings.hasApiKey, true);
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
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".figure-image img")].length === 5 &&
      [...document.querySelectorAll(".figure-image img")].every(
        (img) => img.complete && img.naturalWidth > 0,
      ),
  );
  await page.screenshot({ path: path.join(output, "06-figures.png") });
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
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        modelRequests: requests,
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
}
