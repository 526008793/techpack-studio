import { z } from "zod";
import {
  techPackSchema,
  type ApiSettings,
  type PdfPage,
  type TechPack,
} from "../shared/model";

export const EXTRACTION_PROMPT = `你是服装技术资料制单员。逐页读取提供的PDF文字和页面图像，把资料完整提取为指定JSON，并提供准确中英对照。
规则：
1. 只提取资料提供的事实。未提供的字符串和数字用null，不得沿用旧款、编造数量、交期、工厂、内部跟单或推算尺码。所有数组必须有实际含义，没有项目返回空数组。
2. 材料逐项分开，面料1/2/3即使成分相同也必须独立。kind分为fabric/interlining/graphic/trim/label。不要自动编造衬；本地程序会增加待确认衬行。
3. 英文名称/描述在En字段保留原文，中文字段用服装行业用语翻译。配色中的Pantone/TCX编码原样保留，多个配色按原顺序写colors；数量和规格不得互相混淆。
4. measurements只填写实际提供的样码数值。所有英寸分数转为精确数值，如12 1/2=>12.5，1/8=>0.125。0与未提供必须区分。tolerance为正公差绝对值。原尺寸为文本无法数值化时value=null并在sourceValue保留原文。不将日期误当尺寸。unit必须与原资料一致。
5. construction完整覆盖工艺要求，用titleZh/titleEn、detailZh/detailEn对应。标签参考图中“placeholder/reference only”的成分、产地、日期、款号、工厂等不能当作本款实际资料，在notes及missingItems标明。不得给固定风险评估会写虚构会议意见。
6. figures找出款式彩色图appearance、工艺图construction、辅料参考trimReference、款式参考inspiration、唛头参考labels。page从1开始；box的x/y/width/height是相对整张页面的0~1坐标，从左上角起，裁掉重复页眉但保留该图完整说明。允许一个角色多张图片。不要把尺寸表当作款式图。
7. 在missingItems列出资料真实缺失、模糊及冲突的关键项目。sourceDate按原始资料日期，不是当前时间；客户、品牌、设计、技术、参考款、季节分开。
只输出符合schema的JSON，不输出Markdown。`;

function endpoint(settings: ApiSettings) {
  const url = new URL(settings.baseUrl.trim());
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("API地址必须以 https:// 或 http:// 开头");
  url.pathname =
    url.pathname.replace(/\/$/, "") +
    (settings.protocol === "responses" ? "/responses" : "/chat/completions");
  return url.toString();
}
export async function extractTechPack(
  settings: ApiSettings,
  pages: PdfPage[],
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<TechPack> {
  if (!settings.model.trim()) throw new Error("请先在设置中填写模型名称");
  if (!pages.length) throw new Error("PDF尚未读取完成");
  const schema = z.toJSONSchema(techPackSchema);
  delete schema.$schema;
  const text = pages
    .map(
      (p) => `=== PDF PAGE ${p.number} (${p.width}×${p.height}) ===\n${p.text}`,
    )
    .join("\n\n");
  let body: Record<string, unknown>;
  if (settings.protocol === "responses") {
    const content: unknown[] = [{ type: "input_text", text }];
    for (const page of pages) {
      content.push(
        { type: "input_text", text: `PDF page ${page.number}` },
        { type: "input_image", image_url: page.image, detail: "high" },
      );
    }
    body = {
      model: settings.model,
      store: false,
      input: [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "garment_tech_pack",
          strict: true,
          schema,
        },
      },
    };
  } else {
    const content: unknown[] = [{ type: "text", text }];
    for (const page of pages)
      content.push(
        { type: "text", text: `PDF page ${page.number}` },
        { type: "image_url", image_url: { url: page.image, detail: "high" } },
      );
    body = {
      model: settings.model,
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content },
      ],
      response_format: { type: "json_object" },
    };
    (body.messages as { role: string; content: unknown }[])[0].content =
      EXTRACTION_PROMPT + "\n完整JSON Schema：\n" + JSON.stringify(schema);
  }
  // 两种接口的推理参数不同；跟随服务默认时不发送该参数。
  if (settings.reasoningEffort !== "default") {
    if (settings.protocol === "responses")
      body.reasoning = { effort: settings.reasoningEffort };
    else body.reasoning_effort = settings.reasoningEffort;
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  let response: Response;
  try {
    response = await fetcher(endpoint(settings), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw new Error("识别已取消");
    throw new Error(
      "连接模型失败，请检查网络、API地址或本地模型服务。" +
        (error instanceof Error ? " " + error.message : ""),
    );
  }
  const result = (await response.json().catch(() => null)) as any;
  if (!response.ok) {
    const upstream =
      result?.error?.message || result?.message || `HTTP ${response.status}`;
    throw new Error(
      `识别失败（${response.status}）：${String(upstream).replaceAll(settings.apiKey || "__NO_KEY__", "[已隐藏]")}`,
    );
  }
  if (result?.status === "incomplete")
    throw new Error("模型未返回完整资料，请调整模型的输出额度后重新识别。");
  const parts =
    result?.output?.flatMap((item: any) => item.content || []) || [];
  const refusal = parts.find((part: any) => part.type === "refusal");
  if (refusal)
    throw new Error(
      "模型未能处理这份资料：" + (refusal.refusal || "请检查资料内容"),
    );
  const output =
    settings.protocol === "responses"
      ? result?.output_text ||
        parts
          .filter((part: any) => part.type === "output_text")
          .map((part: any) => part.text)
          .join("")
      : result?.choices?.[0]?.message?.content;
  if (typeof output !== "string" || !output.trim())
    throw new Error("模型返回了空内容，请检查接口类型及模型是否支持图片。");
  let json: unknown;
  try {
    json = JSON.parse(
      output.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
    );
  } catch {
    throw new Error(
      "模型返回的JSON无法解析，请重新识别或换用支持结构化输出的模型。",
    );
  }
  const parsed = techPackSchema.safeParse(json);
  if (!parsed.success)
    throw new Error(
      "模型返回的资料结构不完整：" +
        parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
    );
  const data = parsed.data;
  for (const f of data.figures) {
    if (
      f.page > pages.length ||
      f.box.x < 0 ||
      f.box.y < 0 ||
      f.box.width <= 0 ||
      f.box.height <= 0 ||
      f.box.x + f.box.width > 1.01 ||
      f.box.y + f.box.height > 1.01
    )
      throw new Error("模型返回的图片裁剪位置无效，请重新识别。");
  }
  return data;
}
