import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { extractTechPack } from "../src/main/ai";
import {
  emptyTechPack,
  techPackSchema,
  type ApiSettings,
  type PdfPage,
} from "../src/shared/model";
const config: ApiSettings = {
  protocol: "responses",
  baseUrl: "https://example.invalid/v1",
  model: "test-model",
  reasoningEffort: "xhigh",
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
  assert.deepEqual(sent.reasoning, { effort: "xhigh" });
  assert.equal("reasoning_effort" in sent, false);
  assert.equal(sent.text.format.strict, true);
  const figure = sent.text.format.schema.properties.figures.items;
  assert.ok(figure.required.includes("annotations"));
  assert.equal("default" in figure.properties.annotations, false);
  assert.ok(sent.input[1].content.some((x: any) => x.type === "input_image"));
});
test("reasoning effort uses each API's parameter and can follow the service default", async () => {
  const data = emptyTechPack();
  for (const protocol of ["responses", "chat"] as const) {
    for (const reasoningEffort of ["high", "xhigh", "default"] as const) {
      let sent: any;
      const fake = (async (url: any, options: any) => {
        assert.equal(
          String(url),
          `https://example.invalid/v1/${protocol === "responses" ? "responses" : "chat/completions"}`,
        );
        sent = JSON.parse(options.body);
        return Response.json(
          protocol === "responses"
            ? { output_text: JSON.stringify(data) }
            : { choices: [{ message: { content: JSON.stringify(data) } }] },
        );
      }) as typeof fetch;
      await extractTechPack(
        { ...config, protocol, reasoningEffort },
        pages,
        new AbortController().signal,
        fake,
      );
      if (reasoningEffort === "default") {
        assert.equal("reasoning" in sent, false);
        assert.equal("reasoning_effort" in sent, false);
      } else if (protocol === "responses") {
        assert.deepEqual(sent.reasoning, { effort: reasoningEffort });
        assert.equal("reasoning_effort" in sent, false);
      } else {
        assert.equal(sent.reasoning_effort, reasoningEffort);
        assert.equal("reasoning" in sent, false);
      }
    }
  }
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
test("connection errors explain DNS, proxy, refused, timeout and certificate failures without exposing keys", async () => {
  const failures: [Error, RegExp][] = [
    [
      new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }),
      /无法解析服务域名/,
    ],
    [new Error("net::ERR_PROXY_CONNECTION_FAILED"), /系统代理连接失败/],
    [new Error("net::ERR_CONNECTION_REFUSED"), /服务拒绝连接/],
    [new Error("net::ERR_CONNECTION_TIMED_OUT"), /连接超时/],
    [new Error("net::ERR_CERT_AUTHORITY_INVALID"), /证书校验失败/],
    [new Error(`fetch failed ${config.apiKey}`), /请核对 API 基础地址/],
  ];
  for (const [failure, expected] of failures) {
    const fake = (async () => {
      throw failure;
    }) as typeof fetch;
    await assert.rejects(
      () => extractTechPack(config, pages, new AbortController().signal, fake),
      (error) =>
        error instanceof Error &&
        expected.test(error.message) &&
        error.message.includes("example.invalid") &&
        !error.message.includes(config.apiKey!),
    );
  }
});
