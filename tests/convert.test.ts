import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTemplateFile } from "../src/main/convert";

test("XLSX templates are read directly without a converter", async () => {
  const file = new URL("../resources/template.xlsx", import.meta.url);
  assert.deepEqual(
    await readTemplateFile(fileURLToPath(file), "/missing-converter"),
    await fs.readFile(file),
  );
});

test(
  "bundled XLS conversion uses a temporary copy and cleans up after success or failure",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "techpack-convert-test-"),
    );
    try {
      const source = path.join(directory, "夹克 模板.XLS");
      const original = Buffer.from("original xls bytes");
      await fs.writeFile(source, original);
      const fixture = fileURLToPath(
        new URL("../resources/template.xlsx", import.meta.url),
      );
      const converter = path.join(directory, "local converter");
      const record = path.join(directory, "conversion.json");
      const program = `#!${process.execPath}\nimport fs from 'node:fs/promises';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst args=process.argv.slice(2);\nconst source=args.at(-1);\nconst output=args[args.indexOf('--outdir')+1];\nconst profile=fileURLToPath(args.find(a=>a.startsWith('-env:UserInstallation=')).slice('-env:UserInstallation='.length));\nawait fs.mkdir(profile,{recursive:true});\nawait fs.writeFile(${JSON.stringify(record)},JSON.stringify({args,source,output,profile,bytes:(await fs.readFile(source)).toString()}));\nif(process.env.TECHPACK_TEST_CONVERTER_FAIL)process.exit(1);\nawait fs.copyFile(${JSON.stringify(fixture)},path.join(output,'template.xlsx'));\n`;
      await fs.writeFile(converter, program, { mode: 0o700 });
      const output = await readTemplateFile(source, converter);
      assert.deepEqual(output, await fs.readFile(fixture));
      const log = JSON.parse(await fs.readFile(record, "utf8"));
      assert.notEqual(log.source, source);
      assert.equal(log.bytes, original.toString());
      assert.ok(log.args.includes("--headless"));
      assert.ok(log.profile.startsWith(log.output));
      await assert.rejects(fs.access(log.output));
      assert.deepEqual(await fs.readFile(source), original);
      // 替换为失败转换器，验证异常也不留下临时副本或损坏原文件。
      await fs.writeFile(
        converter,
        program.replace(
          "if(process.env.TECHPACK_TEST_CONVERTER_FAIL)process.exit(1);",
          "process.exit(1);",
        ),
      );
      await assert.rejects(readTemplateFile(source, converter));
      const failure = JSON.parse(await fs.readFile(record, "utf8"));
      await assert.rejects(fs.access(failure.output));
      assert.deepEqual(await fs.readFile(source), original);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
