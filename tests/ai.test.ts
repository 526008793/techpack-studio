import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { extractTechPack } from "../src/main/ai";
import {
  techPackSchema,
  type ApiSettings,
  type PdfPage,
} from "../src/shared/model";
const config: ApiSettings = {
  protocol: "responses",
  baseUrl: "https://example.invalid/v1",
  model: "test-model",
  apiKey: "test-only-secret",
  rememberKey: false,
};
const pages: PdfPage[] = [
  {
    number: 1,
    text: "Body P4541",
    image: "data:image/jpeg;base64,TEST",
    width: 792,
    height: 612,
  },
];
test("Responses sends page images, strict schema and no persistent server storage", async () => {
  const sample = techPackSchema.parse(
    JSON.parse(
      await fs.readFile(
        new URL("../resources/example.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  sample.figures = [];
  let sent: any;
  const fake = (async (url: any, options: any) => {
    assert.equal(String(url), "https://example.invalid/v1/responses");
    sent = JSON.parse(options.body);
    return new Response(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(sample) }],
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const result = await extractTechPack(
    config,
    pages,
    new AbortController().signal,
    fake,
  );
  assert.equal(result.meta.styleNumber, "P4541");
  assert.equal(sent.store, false);
  assert.equal(sent.text.format.strict, true);
  assert.ok(sent.input[1].content.some((x: any) => x.type === "input_image"));
});
test("invalid JSON and missing measurement keys produce actionable errors", async () => {
  const fake = (async () =>
    new Response(JSON.stringify({ output_text: '{"meta":{}}' }), {
      status: 200,
    })) as typeof fetch;
  await assert.rejects(
    () => extractTechPack(config, pages, new AbortController().signal, fake),
    /资料结构不完整/,
  );
});
test("API errors never expose the configured API key", async () => {
  const fake = (async () =>
    new Response(
      JSON.stringify({ error: { message: "bad test-only-secret" } }),
      { status: 401 },
    )) as typeof fetch;
  await assert.rejects(
    () => extractTechPack(config, pages, new AbortController().signal, fake),
    (error) =>
      error instanceof Error &&
      !error.message.includes("test-only-secret") &&
      error.message.includes("401"),
  );
});
