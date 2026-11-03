import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright-core";
import electronPath from "electron";
import JSZip from "jszip";

const [template, pdf, fixture] = process.argv.slice(2);
if (!fixture)
  throw new Error(
    "Usage: node scripts/smoke-template.mjs template.xlsx test.pdf expected-data.json",
  );
const root = process.cwd();
const output = path.join(root, "output/templates");
await fs.mkdir(output, { recursive: true });
const data = JSON.parse(await fs.readFile(fixture, "utf8"));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "techpack-template-"));
let requests = 0;
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  assert.deepEqual(body.reasoning, { effort: "xhigh" });
  assert.equal(
    body.input[1].content.filter((part) => part.type === "input_image").length,
    5,
  );
  requests++;
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ output_text: JSON.stringify(data) }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const environment = { ...process.env, TECHPACK_USER_DATA: profile };
delete environment.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({
    executablePath: electronPath,
    args: [".", "--use-mock-keychain"],
    cwd: root,
    env: environment,
  });
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "开始一份新制单" }).waitFor();
  await app.evaluate(({ session }) =>
    session.defaultSession.setProxy({ mode: "direct" }),
  );
  await page.evaluate(
    (port) =>
      window.techpack.saveSettings({
        protocol: "responses",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "mock-garment-vision",
        reasoningEffort: "xhigh",
        rememberKey: false,
      }),
    port,
  );
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, template);
  await page.getByRole("button", { name: "选择其他模板", exact: true }).click();
  await page
    .getByRole("heading", { name: path.basename(template), exact: true })
    .waitFor();
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, pdf);
  await page
    .getByRole("button", { name: "选择 PDF 文件", exact: false })
    .click();
  await page
    .getByText("已读取 5 页", { exact: true })
    .waitFor({ timeout: 60000 });
  await page
    .getByRole("button", { name: "识别并整理资料", exact: false })
    .click();
  await page
    .getByRole("heading", {
      name: `${data.meta.styleNumber} ${data.meta.styleName}`,
      exact: true,
    })
    .waitFor({ timeout: 60000 });
  await page.getByRole("tab", { name: "图片参考", exact: true }).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".figure-image img")].length === 5 &&
      [...document.querySelectorAll(".figure-image img")].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
  );
  await page.screenshot({ path: path.join(output, "jacket-review.png") });
  const destination = path.join(output, "jacket-desktop.xlsx");
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, destination);
  await page
    .getByRole("button", { name: "生成 Excel 制单", exact: false })
    .click();
  await page
    .getByRole("heading", { name: "新制单已生成", exact: true })
    .waitFor({ timeout: 60000 });
  assert.equal(await page.locator(".sheet-list > div").count(), 12);
  assert.equal(requests, 1);
  const zip = await JSZip.loadAsync(await fs.readFile(destination));
  const book = await zip.file("xl/workbook.xml").async("string");
  assert.equal([...book.matchAll(/<sheet\b/g)].length, 12);
  assert.ok(book.includes('name="CAD-02 (3)"'));
  assert.ok(
    Object.keys(zip.files).filter((file) => file.startsWith("xl/media/tp-"))
      .length >= 6,
  );
  await page.screenshot({ path: path.join(output, "jacket-export.png") });
  console.log(
    JSON.stringify(
      {
        passed: true,
        fixture: "synthetic jacket PDF and mock model",
        sheets: 12,
        modelRequests: requests,
        output: destination,
      },
      null,
      2,
    ),
  );
} finally {
  if (app) await app.close();
  server.close();
  await fs.rm(profile, { recursive: true, force: true });
}
