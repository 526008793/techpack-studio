import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsStore, cacheKey } from "../src/main/storage";
import { DEFAULT_TEMPLATE_RULES } from "../src/shared/model";
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
      reasoningEffort: "xhigh",
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
test("new and legacy settings default to xhigh and preserve the selected effort after restart", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "techpack-effort-"));
  const cipher = {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  };
  try {
    const fresh = new SettingsStore(dir, cipher);
    assert.equal((await fresh.load()).reasoningEffort, "xhigh");
    await fs.writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({
        protocol: "chat",
        baseUrl: "https://example.invalid/v1",
        model: "existing-model",
        rememberKey: false,
      }),
    );
    const upgraded = new SettingsStore(dir, cipher);
    const settings = await upgraded.load();
    assert.equal(settings.reasoningEffort, "xhigh");
    assert.equal(settings.model, "existing-model");
    assert.equal(settings.protocol, "chat");
    assert.deepEqual(settings.templateRules, DEFAULT_TEMPLATE_RULES);
    for (const reasoningEffort of ["high", "default", "xhigh"] as const) {
      await upgraded.save({ ...settings, reasoningEffort });
      const restarted = new SettingsStore(dir, cipher);
      assert.equal((await restarted.load()).reasoningEffort, reasoningEffort);
    }
    for (const templateRules of [["第一条自定义规则", "另一条规则"], []]) {
      await upgraded.save({ ...settings, templateRules });
      const restarted = new SettingsStore(dir, cipher);
      assert.deepEqual((await restarted.load()).templateRules, templateRules);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("cache identity changes with PDF, model and reasoning effort", () => {
  const settings = {
    protocol: "responses" as const,
    baseUrl: "https://example.invalid/v1",
    model: "a",
    reasoningEffort: "xhigh" as const,
    rememberKey: false,
  };
  assert.notEqual(cacheKey("a", settings), cacheKey("b", settings));
  assert.notEqual(
    cacheKey("a", settings),
    cacheKey("a", { ...settings, model: "b" }),
  );
  assert.notEqual(
    cacheKey("a", settings),
    cacheKey("a", { ...settings, reasoningEffort: "high" }),
  );
  assert.notEqual(
    cacheKey("a", settings),
    cacheKey("a", { ...settings, reasoningEffort: "default" }),
  );
});
