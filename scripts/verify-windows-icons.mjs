import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";

const root = process.cwd();
const config = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
const expected = Data.IconFile.from(
  await fs.readFile(path.join(root, "build/icon.ico")),
).icons.map((i) => i.data);
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
assert.deepEqual(
  expected.map((i) => i.width || i.bitmapInfo.width),
  sizes,
);
assert.ok(expected.every((i) => i.isIcon() && i.bitmapInfo.bitCount === 32));

async function verify(file) {
  const bytes = await fs.readFile(file);
  const resources = NtExecutableResource.from(NtExecutable.from(bytes));
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  const matching = groups.find((group) => {
    const icons = group
      .getIconItemsFromEntries(resources.entries)
      .sort(
        (a, b) =>
          (a.bitmapInfo?.width || a.width) - (b.bitmapInfo?.width || b.width),
      );
    return (
      icons.length === expected.length &&
      icons.every(
        (icon, index) =>
          icon.isIcon() &&
          icon.bitmapInfo.width === sizes[index] &&
          Buffer.from(icon.pixels).equals(
            Buffer.from(expected[index].pixels),
          ) &&
          Buffer.from(icon.masks).equals(Buffer.from(expected[index].masks)),
      )
    );
  });
  assert.ok(matching, `ZHH icon pixels are missing or different in ${file}`);
  return matching;
}
const appDir = path.join(root, "dist/windows/win-unpacked");
const group = await verify(path.join(appDir, "制单助手.exe"));
await verify(
  path.join(
    root,
    `dist/windows/TechPack-Studio-Setup-${config.version}-x64.exe`,
  ),
);
assert.deepEqual(
  await fs.readFile(path.join(appDir, "resources/resources/app-icon.ico")),
  await fs.readFile(path.join(root, "build/icon.ico")),
);
assert.deepEqual(
  await fs.readFile(path.join(appDir, "resources/resources/app-icon.png")),
  await fs.readFile(path.join(root, "resources/app-icon.png")),
);
const executable = NtExecutableResource.from(
  NtExecutable.from(await fs.readFile(path.join(appDir, "制单助手.exe"))),
);
const extracted = new Data.IconFile();
extracted.icons = group
  .getIconItemsFromEntries(executable.entries)
  .map((data) => ({ data }));
await fs.mkdir(path.join(root, "output"), { recursive: true });
await fs.writeFile(
  path.join(root, "output/zhh-extracted-from-exe.ico"),
  Buffer.from(extracted.generate()),
);
console.log(
  `PASS: v${config.version} application and installer contain all 10 ZHH icon sizes, exact bitmap pixels and transparency; installed ICO/PNG assets match.`,
);
