import test from "node:test";
import assert from "node:assert/strict";
import {
  chinese,
  chineseColor,
  chineseLabel,
  chineseExportWarnings,
} from "../src/shared/chinese-text";
import { emptyTechPack } from "../src/shared/model";

test("Chinese fields do not fall back to English and colors preserve real identifiers", () => {
  assert.equal(chinese(null), "待确认");
  assert.equal(chinese("大身"), "大身");
  assert.equal(chinese("本地采购 / LOCALLY SOURCED"), "本地采购");
  assert.equal(chinese("总长56英寸 / TOTAL 56 inch"), "总长56英寸");
  assert.equal(chinese("PDF p.2"), "PDF第2页");
  assert.equal(chinese("UFC HANGTAG"), "待确认");
  assert.equal(chinese("UNI-4106-TRK"), "UNI-4106-TRK");
  assert.equal(chineseColor("RAISIN 19-1606 TCX"), "葡萄干色 19-1606 TCX");
  assert.equal(
    chineseColor("RAISIN 19-1606 TCX\n葡萄干色"),
    "葡萄干色 19-1606 TCX",
  );
  assert.equal(chineseColor("BLACK"), "黑色");
  assert.equal(
    chineseColor("MYSTERY 19-1606 TCX"),
    "19-1606 TCX（色名待确认）",
  );
  assert.equal(chineseColor("CUSTOM UNKNOWN"), "待确认");
  assert.equal(chineseColor("客户色 123"), "客户色 123");
  assert.equal(chineseLabel("订单号 / ORDER: ABC123"), "订单号: ABC123");
  assert.equal(chineseLabel("单位\nUNIT"), "单位");
  assert.equal(chineseLabel("COLORWAY 2"), "配色2");
  assert.equal(chineseLabel("Material specification", "spec"), "规格");
  const data = emptyTechPack();
  data.meta.descriptionEn = "ONLY ENGLISH";
  assert.ok(
    chineseExportWarnings(data).some((text) => text.includes("中文品名")),
  );
});
