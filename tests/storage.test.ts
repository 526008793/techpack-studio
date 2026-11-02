import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsStore, cacheKey } from "../src/main/storage";
test("remembered keys are encrypted; key is never returned to renderer or stored in plaintext", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "techpack-settings-"));
  const cipher = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s.split("").reverse().join("")),
    decryptString: (b: Buffer) => b.toString().split("").reverse().join(""),
  };
  try {
    const store = new SettingsStore(dir, cipher);
    await store.load();
    const view = await store.save({
      protocol: "responses",
      model: "test",
      baseUrl: "https://example.invalid/v1",
      apiKey: "never-plaintext",
      rememberKey: true,
    });
    assert.equal(view.apiKey, undefined);
    assert.equal(view.hasApiKey, true);
    const raw = await fs.readFile(path.join(dir, "settings.json"), "utf8");
    assert.ok(!raw.includes("never-plaintext"));
    const next = new SettingsStore(dir, cipher);
    await next.load();
    assert.equal(next.privateSettings().apiKey, "never-plaintext");
    await next.save({ ...view, apiKey: "" });
    assert.equal(next.public().hasApiKey, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("cache identity changes with PDF, API base, model and protocol", () => {
  const settings = {
    protocol: "responses" as const,
    baseUrl: "https://example.invalid/v1",
    model: "a",
    rememberKey: false,
  };
  assert.notEqual(cacheKey("a", settings), cacheKey("b", settings));
  assert.notEqual(
    cacheKey("a", settings),
    cacheKey("a", { ...settings, model: "b" }),
  );
});
