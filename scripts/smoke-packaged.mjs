import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright-core";
import JSZip from "jszip";
const root = process.cwd(),
  executable = process.env.TECHPACK_PACKAGED_EXECUTABLE;
if (!executable)
  throw new Error(
    "Set TECHPACK_PACKAGED_EXECUTABLE to the packaged app binary.",
  );
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "techpack-packaged-"));
const destination = path.join(root, "output/playwright/packaged-example.xlsx");
const environment = { ...process.env, TECHPACK_USER_DATA: profile };
delete environment.ELECTRON_RUN_AS_NODE;
let application;
try {
  application = await _electron.launch({
    executablePath: executable,
    args: ["--use-mock-keychain"],
    cwd: root,
    env: environment,
  });
  const page = await application.firstWindow(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  await page.getByRole("heading", { name: "开始一份新制单" }).waitFor();
  await page
    .getByRole("button", { name: "查看 P4541 示例", exact: false })
    .click();
  await page
    .getByRole("heading", { name: "P4541 RANDY", exact: true })
    .waitFor({ timeout: 60000 });
  await page.getByRole("tab", { name: "尺寸表", exact: true }).click();
  assert.equal(await page.locator(".measure-table tbody tr").count(), 23);
  await application.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, destination);
  await page
    .getByRole("button", { name: "生成 Excel 制单", exact: false })
    .click();
  await page
    .getByRole("heading", { name: "新制单已生成" })
    .waitFor({ timeout: 60000 });
  const zip = await JSZip.loadAsync(await fs.readFile(destination));
  assert.match(
    await zip.file("xl/worksheets/sheet7.xml").async("string"),
    /<v>16<\/v>/,
  );
  assert.equal(await page.locator(".sheet-list > div").count(), 11);
  await page.screenshot({
    path: path.join(root, "output/playwright/08-packaged.png"),
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: packaged app resources, PDF worker, reviewed example, 23 POMs and 11-sheet export.",
  );
} finally {
  if (application) await application.close();
  await fs.rm(profile, { recursive: true, force: true });
}
