import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// 只接收通过官方摘要校验的 Windows 安装源；不把 MSI 或用户模板打进 App。
const [msi, extracted] = process.argv.slice(2);
assert.ok(
  extracted,
  "Usage: node scripts/prepare-windows-converter.mjs official.msi extracted-directory",
);
const sha256 =
  "480fecf759fc6393bd614fbf43753eb95a8198fc1a065d41b727e3b664cd1e59";
assert.equal(
  createHash("sha256")
    .update(await fs.readFile(msi))
    .digest("hex"),
  sha256,
);
const source = path.resolve(extracted);
const entries = await fs.readdir(source, {
  recursive: true,
  withFileTypes: true,
});
const files = entries
  .filter((entry) => entry.isFile())
  .map((entry) => path.join(entry.parentPath, entry.name));
const office = files.find((file) =>
  file.endsWith(path.join("program", "soffice.exe")),
);
assert.ok(office, "Extract the official MSI before preparing the converter");
const target = path.resolve("output/windows-converter/LibreOffice");
await fs.rm(target, { recursive: true, force: true });
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.cp(path.dirname(path.dirname(office)), target, { recursive: true });

// msiextract 会把 x64/ARM64 的同名运行库写入同一目录。直接按 MSI 内部标识
// 单独提取 amd64 文件，避免被后面的 ARM64 文件覆盖；不改系统目录。
const runtimeDirectory = path.resolve("output/windows-converter/vc-runtime");
await fs.rm(runtimeDirectory, { recursive: true, force: true });
await run(process.env.TECHPACK_7ZIP || "7zz", [
  "x",
  "-y",
  `-o${runtimeDirectory}`,
  path.resolve(msi),
  "*.dll_amd64.*",
]);
const runtimes = new Set();
for (const name of await fs.readdir(runtimeDirectory)) {
  const file = path.join(runtimeDirectory, name);
  const bytes = await fs.readFile(file);
  const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, "Runtime must be x64");
  const filename = name.split("_amd64.")[0];
  await fs.copyFile(file, path.join(target, "program", filename));
  runtimes.add(filename.toLowerCase());
}
await fs.rm(runtimeDirectory, { recursive: true, force: true });
for (const file of ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"]) {
  assert.ok(runtimes.has(file), `Missing x64 runtime: ${file}`);
}
for (const file of [
  "program/soffice.exe",
  "program/soffice.bin",
  "program/bootstrap.ini",
  "program/fundamental.ini",
  "LICENSE.html",
  "license.txt",
  "NOTICE",
]) {
  await fs.access(path.join(target, file));
}
await fs.writeFile(
  path.join(target, "SOURCE.json"),
  JSON.stringify(
    {
      version: "26.2.7.3",
      architecture: "x64",
      url: "https://download.documentfoundation.org/libreoffice/stable/26.2.7/win/x86_64/LibreOffice_26.2.7_Win_x86-64.msi",
      sha256,
      license: "LICENSE.html",
    },
    null,
    2,
  ),
);
console.log(
  `Prepared Windows XLS converter: ${target}; ${runtimes.size} local x64 runtime DLLs`,
);
