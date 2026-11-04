import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { atomicJson } from "./storage";
import type { CacheSettings } from "../shared/model";

export class CacheStore {
  readonly defaultDirectory: string;
  directory: string;
  private locations: string[];

  constructor(
    private userData: string,
    installDirectory: string,
  ) {
    this.defaultDirectory = path.join(
      installDirectory,
      "techpack-studio-cache",
    );
    this.directory = this.defaultDirectory;
    this.locations = [path.join(userData, "cache"), this.defaultDirectory];
  }

  async load() {
    try {
      const raw = JSON.parse(
        await fs.readFile(
          path.join(this.userData, "cache-settings.json"),
          "utf8",
        ),
      );
      if (typeof raw.directory !== "string" || !path.isAbsolute(raw.directory))
        throw new Error("缓存目录无效");
      this.directory =
        raw.directory === path.join(this.userData, "cache") ||
        raw.directory === raw.defaultDirectory
          ? this.defaultDirectory
          : raw.directory;
      this.locations = [
        ...new Set<string>([
          ...this.locations,
          ...(Array.isArray(raw.locations)
            ? raw.locations.filter(
                (p: unknown) => typeof p === "string" && path.isAbsolute(p),
              )
            : []),
          this.directory,
        ]),
      ];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("本地缓存目录设置无法读取");
    }
    await fs.mkdir(this.directory, { recursive: true });
    await fs.access(this.directory, constants.W_OK);
    // 旧默认位置的识别结果搬到安装目录，升级后仍可命中缓存。
    if (this.directory === this.defaultDirectory) {
      const legacy = path.join(this.userData, "cache");
      const files = await fs
        .readdir(legacy)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
      for (const file of files.filter((name) =>
        /^[a-f0-9]{64}\.json(?:\.tmp)?$/.test(name),
      )) {
        await fs
          .copyFile(
            path.join(legacy, file),
            path.join(this.directory, file),
            constants.COPYFILE_EXCL,
          )
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
        await fs.unlink(path.join(legacy, file));
      }
    }
    await this.writeUninstallLocations(this.locations);
    await atomicJson(path.join(this.userData, "cache-settings.json"), {
      directory: this.directory,
      defaultDirectory: this.defaultDirectory,
      locations: this.locations,
    });
    return this.public();
  }

  public(): CacheSettings {
    return {
      directory: this.directory,
      defaultDirectory: this.defaultDirectory,
    };
  }

  async changeDirectory(directory: string) {
    await fs.mkdir(directory, { recursive: true });
    await fs.access(directory, constants.W_OK);
    const locations = [...new Set([...this.locations, directory])];
    // 先登记卸载位置，再切换缓存；旧目录中的缓存也能在卸载时清理。
    await this.writeUninstallLocations(locations);
    await atomicJson(path.join(this.userData, "cache-settings.json"), {
      directory,
      defaultDirectory: this.defaultDirectory,
      locations,
    });
    this.directory = directory;
    this.locations = locations;
    console.info("[cache:directory-changed]", {
      custom: directory !== this.defaultDirectory,
    });
    return this.public();
  }

  async clearCurrent() {
    return this.clearDirectory(this.directory);
  }

  async clearAll() {
    for (const directory of this.locations) {
      // 卸载只递归删除本程序的专用目录，不删除用户选择的父目录。
      if (
        directory !== path.join(this.userData, "cache") &&
        path.basename(directory) !== "techpack-studio-cache"
      )
        throw new Error("无法清理非程序专用的缓存目录");
      await fs.rm(directory, { recursive: true, force: true });
    }
    console.info("[cache:uninstall-cleared]", {
      directories: this.locations.length,
    });
  }

  private async clearDirectory(directory: string) {
    let files;
    try {
      files = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    // 只清理本程序按 SHA-256 命名的识别结果；不递归删除自定义目录。
    const cached = files.filter(
      (f) => f.isFile() && /^[a-f0-9]{64}\.json(?:\.tmp)?$/.test(f.name),
    );
    await Promise.all(
      cached.map((file) => fs.unlink(path.join(directory, file.name))),
    );
    try {
      await fs.rmdir(directory);
    } catch (error) {
      if (
        !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
          (error as NodeJS.ErrnoException).code || "",
        )
      )
        throw error;
    }
    console.info("[cache:cleared]", { files: cached.length });
    return cached.length;
  }

  private async writeUninstallLocations(locations: string[]) {
    await fs.mkdir(this.userData, { recursive: true });
    const ini =
      "\ufeff[Cache]\r\nCount=" +
      locations.length +
      "\r\n" +
      locations
        .map((directory, i) => `\r\n[Cache${i}]\r\nDirectory=${directory}\r\n`)
        .join("");
    const file = path.join(this.userData, "cache-locations.ini");
    await fs.writeFile(file + ".tmp", ini, "utf16le");
    await fs.rename(file + ".tmp", file);
  }
}
