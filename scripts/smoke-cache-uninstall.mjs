import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { _electron } from "playwright-core";

const sourceExecutable = process.argv[2];
assert.ok(sourceExecutable, "Pass the packaged macOS executable path");
const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "techpack-uninstall-test-")),
);
const profile = path.join(root, "profile");
const install = path.join(root, "安装 目录");
const logs = path.join(root, "logs");
const sourceBundle = path.dirname(path.dirname(path.dirname(sourceExecutable)));
const bundle = path.join(install, path.basename(sourceBundle));
const executable = path.join(
  bundle,
  "Contents/MacOS",
  path.basename(sourceExecutable),
);
const run = promisify(execFile);
await fs.mkdir(install);
await fs.mkdir(logs);
// 真实卸载只作用于临时 App 副本及临时配置，源 App 与用户数据不参与测试。
await run("/usr/bin/ditto", [sourceBundle, bundle]);
await fs.writeFile(path.join(install, "user-document.txt"), "keep");
await fs.writeFile(path.join(logs, "application.log"), "test-log");
const env = { ...process.env, TECHPACK_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
let application;
try {
  application = await _electron.launch({
    executablePath: executable,
    args: ["--use-mock-keychain"],
    env,
  });
  const page = await application.firstWindow();
  await page.getByRole("heading", { name: "开始一份新制单" }).waitFor();
  const state = await application.evaluate(({ app }, logs) => {
    app.setPath("logs", logs);
    return { packaged: app.isPackaged, profile: app.getPath("userData") };
  }, logs);
  assert.equal(state.packaged, true);
  assert.equal(state.profile, profile);
  const defaultCache = path.join(install, "techpack-studio-cache");
  const cacheSettings = await page.evaluate(() =>
    window.techpack.cacheSettings(),
  );
  assert.equal(cacheSettings.directory, defaultCache);
  assert.equal(cacheSettings.defaultDirectory, defaultCache);
  await fs.writeFile(
    path.join(defaultCache, "a".repeat(64) + ".json"),
    "test-cache",
  );
  await page
    .locator(".sidebar-bottom")
    .getByRole("button", { name: "清除缓存", exact: false })
    .click();
  await page
    .getByText("已清理 1 个缓存文件，下次识别会重新调用 AI。", { exact: true })
    .waitFor();
  await page.screenshot({ path: "output/cache-v111-home.png" });
  await assert.rejects(
    fs.access(path.join(defaultCache, "a".repeat(64) + ".json")),
  );
  await fs.mkdir(path.join(defaultCache, "nested"), { recursive: true });
  await fs.writeFile(
    path.join(defaultCache, "nested", "all-files.txt"),
    "remove",
  );
  await page.evaluate(() =>
    window.techpack.saveSettings({
      protocol: "responses",
      baseUrl: "https://example.invalid/v1",
      model: "mock-only",
      reasoningEffort: "xhigh",
      apiKey: "fake-uninstall-test-key",
      rememberKey: true,
    }),
  );
  for (const name of ["first", "second"]) {
    const directory = path.join(root, name);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "user-document.txt"), "keep");
    await application.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, directory);
    await page.evaluate(() => window.techpack.chooseCacheDirectory());
    const cache = path.join(directory, "techpack-studio-cache");
    await fs.writeFile(
      path.join(cache, "a".repeat(64) + ".json"),
      "test-cache",
    );
    await fs.mkdir(path.join(cache, "nested"));
    await fs.writeFile(path.join(cache, "nested", "all-files.txt"), "remove");
  }
  const settingsFile = path.join(profile, "settings.json");
  assert.ok(
    !(await fs.readFile(settingsFile, "utf8")).includes(
      "fake-uninstall-test-key",
    ),
  );
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    });
  });
  await page
    .getByRole("button", { name: "模型与 API 设置", exact: false })
    .click();
  await page
    .getByRole("button", { name: "卸载并清除本机数据", exact: true })
    .click();
  await fs.access(settingsFile);
  await fs.access(executable);
  await fs.access(defaultCache);
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    });
  });
  const exited = new Promise((resolve) =>
    application.process().once("exit", resolve),
  );
  await page
    .getByRole("button", { name: "卸载并清除本机数据", exact: true })
    .click()
    .catch((error) => {
      if (!/closed|destroyed|exited/i.test(error.message)) throw error;
    });
  await exited;
  application = null;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (
      !(await fs.lstat(bundle).then(
        () => true,
        () => false,
      )) &&
      !(await fs.lstat(profile).then(
        () => true,
        () => false,
      ))
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const directory of [
    bundle,
    profile,
    logs,
    defaultCache,
    ...["first", "second"].map((name) =>
      path.join(root, name, "techpack-studio-cache"),
    ),
  ])
    await assert.rejects(fs.access(directory));
  for (const directory of [
    install,
    ...["first", "second"].map((name) => path.join(root, name)),
  ])
    assert.equal(
      await fs.readFile(path.join(directory, "user-document.txt"), "utf8"),
      "keep",
    );
  await fs.access(sourceExecutable);
  console.log(
    "PASS: installation-directory default, sidebar clear-cache button, uninstall cancellation, and real deletion of the disposable App, all cache directories, logs and API configuration; user files outside dedicated directories remain.",
  );
} finally {
  if (application) await application.close();
  await fs.rm(root, { recursive: true, force: true });
}
