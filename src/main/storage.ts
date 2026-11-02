import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  type ApiSettings,
  techPackSchema,
  type TechPack,
  DEFAULT_TEMPLATE_RULES,
} from "../shared/model";

export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
const defaults: ApiSettings = {
  protocol: "responses",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-6.1-sol",
  reasoningEffort: "xhigh",
  rememberKey: true,
  templateRules: [...DEFAULT_TEMPLATE_RULES],
};
export class SettingsStore {
  private memoryKey = "";
  private settings: ApiSettings = { ...defaults };
  constructor(
    private directory: string,
    private cipher: Cipher,
  ) {}
  async load() {
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(this.directory, "settings.json"), "utf8"),
      );
      this.settings = {
        protocol: raw.protocol === "chat" ? "chat" : "responses",
        baseUrl: raw.baseUrl || defaults.baseUrl,
        model: raw.model || defaults.model,
        // 旧版设置没有推理强度字段，升级后使用 xhigh。
        reasoningEffort: raw.reasoningEffort || defaults.reasoningEffort,
        rememberKey: raw.rememberKey !== false,
        templateRules: raw.templateRules ?? [...DEFAULT_TEMPLATE_RULES],
      };
      if (raw.encryptedKey && this.cipher.isEncryptionAvailable())
        this.memoryKey = this.cipher.decryptString(
          Buffer.from(raw.encryptedKey, "base64"),
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("本地模型设置无法读取，请重新保存设置。");
    }
    return this.public();
  }
  public(): ApiSettings {
    return { ...this.settings, hasApiKey: !!this.memoryKey };
  }
  privateSettings(): ApiSettings {
    return { ...this.settings, apiKey: this.memoryKey };
  }
  async save(next: ApiSettings) {
    const url = new URL(next.baseUrl.trim());
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("请输入有效的API地址");
    if (!next.model.trim()) throw new Error("模型名称不能为空");
    if (next.apiKey !== undefined) this.memoryKey = next.apiKey.trim();
    this.settings = {
      protocol: next.protocol,
      baseUrl: url.toString().replace(/\/$/, ""),
      model: next.model.trim(),
      reasoningEffort: next.reasoningEffort,
      rememberKey: next.rememberKey,
      templateRules: next.templateRules ?? [...DEFAULT_TEMPLATE_RULES],
    };
    const encryptedKey =
      this.memoryKey && next.rememberKey ? this.encrypt(this.memoryKey) : null;
    await atomicJson(path.join(this.directory, "settings.json"), {
      ...this.settings,
      encryptedKey,
    });
    return this.public();
  }
  private encrypt(key: string) {
    if (!this.cipher.isEncryptionAvailable())
      throw new Error("当前电脑的系统加密不可用，请取消“记住API Key”后保存。");
    return this.cipher.encryptString(key).toString("base64");
  }
}
export async function atomicJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
}
export function cacheKey(pdfHash: string, settings: ApiSettings) {
  return createHash("sha256")
    .update(
      [
        pdfHash,
        settings.baseUrl,
        settings.model,
        settings.protocol,
        // 不同推理强度的识别结果分别缓存。
        settings.reasoningEffort,
        "schema-1",
      ].join("\n"),
    )
    .digest("hex");
}
export async function readCache(
  directory: string,
  key: string,
): Promise<TechPack | null> {
  try {
    return techPackSchema.parse(
      JSON.parse(
        await fs.readFile(path.join(directory, "cache", key + ".json"), "utf8"),
      ),
    );
  } catch {
    return null;
  }
}
export async function writeCache(
  directory: string,
  key: string,
  data: TechPack,
) {
  await atomicJson(path.join(directory, "cache", key + ".json"), data);
}
