import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CacheStore } from "../src/main/cache";
import { readCache, writeCache } from "../src/main/storage";
import { emptyTechPack } from "../src/shared/model";

test("default cache uses the installation directory and migrates legacy results; custom locations survive restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "techpack-cache-"));
  try {
    const userData = path.join(root, "profile");
    const legacy = path.join(userData, "cache"),
      key = "a".repeat(64);
    const original = emptyTechPack();
    original.meta.styleNumber = "LEGACY";
    await writeCache(legacy, key, original);
    await fs.writeFile(
      path.join(userData, "settings.json"),
      "existing encrypted configuration",
    );
    const install = path.join(root, "安装 目录");
    const store = new CacheStore(userData, install);
    assert.equal(
      (await store.load()).directory,
      path.join(install, "techpack-studio-cache"),
    );
    await assert.rejects(fs.access(path.join(legacy, key + ".json")));
    assert.equal(
      (await readCache(store.directory, key))?.meta.styleNumber,
      "LEGACY",
    );
    const custom = path.join(root, "自定义 位置", "techpack-studio-cache");
    await store.changeDirectory(custom);
    assert.equal(await readCache(store.directory, key), null);
    const newer = emptyTechPack();
    newer.meta.styleNumber = "CUSTOM";
    await writeCache(store.directory, key, newer);
    const reopened = new CacheStore(userData, install);
    assert.equal((await reopened.load()).directory, custom);
    assert.equal(
      (await readCache(reopened.directory, key))?.meta.styleNumber,
      "CUSTOM",
    );
    const ini = await fs.readFile(path.join(userData, "cache-locations.ini"));
    assert.deepEqual([...ini.subarray(0, 2)], [255, 254]);
    assert.ok(ini.toString("utf16le").includes(`Directory=${custom}\r\n`));
    assert.ok(ini.toString("utf16le").includes("Count=3"));
    await reopened.changeDirectory(reopened.defaultDirectory);
    assert.equal(
      (await readCache(reopened.directory, key))?.meta.styleNumber,
      "LEGACY",
    );
    assert.equal(
      await fs.readFile(path.join(userData, "settings.json"), "utf8"),
      "existing encrypted configuration",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("uninstall removes every file and subdirectory in dedicated caches while preserving their parent folders", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "techpack-cache-clear-"),
  );
  try {
    const store = new CacheStore(
      path.join(root, "profile"),
      path.join(root, "install"),
    );
    await store.load();
    const first = path.join(root, "first", "techpack-studio-cache");
    const second = path.join(root, "second", "techpack-studio-cache");
    await fs.mkdir(path.dirname(first), { recursive: true });
    await fs.writeFile(
      path.join(path.dirname(first), "user-document.txt"),
      "keep",
    );
    await store.changeDirectory(first);
    await writeCache(first, "b".repeat(64), emptyTechPack());
    await fs.writeFile(path.join(first, "keep-me.json"), "personal data");
    await fs.mkdir(path.join(first, "personal"));
    await fs.writeFile(path.join(first, "personal", "document.txt"), "keep");
    await store.changeDirectory(second);
    await writeCache(second, "c".repeat(64), emptyTechPack());
    await fs.writeFile(
      path.join(second, "d".repeat(64) + ".json.tmp"),
      "partial",
    );
    assert.equal(await store.clearCurrent(), 2);
    assert.equal((await readCache(first, "b".repeat(64))) !== null, true);
    assert.equal(await store.clearCurrent(), 0);
    await store.clearAll();
    assert.equal(await readCache(first, "b".repeat(64)), null);
    await assert.rejects(fs.access(first));
    await assert.rejects(fs.access(second));
    await assert.rejects(fs.access(store.defaultDirectory));
    assert.equal(
      await fs.readFile(
        path.join(path.dirname(first), "user-document.txt"),
        "utf8",
      ),
      "keep",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failed cache directory change keeps the existing location and saved configuration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "techpack-cache-fail-"));
  try {
    const store = new CacheStore(
      path.join(root, "profile"),
      path.join(root, "install"),
    );
    await store.load();
    await store.changeDirectory(store.defaultDirectory);
    const saved = await fs.readFile(
      path.join(root, "profile", "cache-settings.json"),
    );
    const file = path.join(root, "not-a-directory");
    await fs.writeFile(file, "file");
    await assert.rejects(store.changeDirectory(file));
    assert.equal(store.directory, store.defaultDirectory);
    assert.deepEqual(
      await fs.readFile(path.join(root, "profile", "cache-settings.json")),
      saved,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("old default cache settings follow the installation path and uninstall rejects a non-owned history directory", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "techpack-cache-upgrade-"),
  );
  try {
    const profile = path.join(root, "profile");
    const legacy = path.join(profile, "cache");
    const install = path.join(root, "install");
    await fs.mkdir(profile);
    await fs.writeFile(
      path.join(profile, "cache-settings.json"),
      JSON.stringify({ directory: legacy, locations: [legacy] }),
    );
    const store = new CacheStore(profile, install);
    assert.equal(
      (await store.load()).directory,
      path.join(install, "techpack-studio-cache"),
    );
    await store.changeDirectory(store.defaultDirectory);
    const moved = new CacheStore(profile, path.join(root, "moved-install"));
    assert.equal(
      (await moved.load()).directory,
      path.join(root, "moved-install", "techpack-studio-cache"),
    );
    await fs.writeFile(
      path.join(profile, "cache-settings.json"),
      JSON.stringify({ directory: store.defaultDirectory, locations: [root] }),
    );
    const invalid = new CacheStore(profile, install);
    await invalid.load();
    await assert.rejects(invalid.clearAll(), /非程序专用/);
    await fs.access(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
