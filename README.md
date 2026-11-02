# 制单助手

Windows 桌面工具：读取服装 PDF 技术资料，经人工核对后，按已确认的十一页模板生成可编辑的中英对照 Excel。

[下载 Windows x64 安装包](https://github.com/526008793/techpack-studio/releases/latest)

## 使用

1. 运行 `TechPack-Studio-Setup-1.0.0-x64.exe` 安装，桌面快捷方式为“制单助手”。
2. 第一次可点击“查看 P4541 示例”，直接体验核对和导出，不需要 API Key。
3. 处理新资料时，在“模型与 API 设置”填写支持图片输入的模型服务地址、模型名称和 API Key。
4. 选择 PDF，使用内置模板，或选择同格式的 `.xlsx` 模板，然后点击“识别并整理资料”。
5. 核对款式、面辅料、尺寸、工艺和图片裁剪范围。缺失数据保持空白，导出时显示为待确认。
6. 点击“生成 Excel 制单”并选择保存位置。用 Excel 或 WPS 打开并查看打印预览。

识别结果可通过“保存资料”存为 JSON，下次导入继续修改。相同 PDF、模型和接口的识别结果会在本机缓存。手动填写、导入已有资料和本地导出不需要调用模型。

## 固定模板规则

- 面料分别列出，即使成分相同也不合并。
- 自动增加独立的“衬 / INTERLINING”，不编造规格和使用部位；同步面辅料表、风险评估会、耗料单及面料留卡。
- 绣章行不标黄。
- “客人意见或邮件”保留所选模板的内容。
- 风险评估会保留原文：`风险评估会意见：【版师在制版前找业务要客户原始资料或样衣照片，参考清晰图片做样】`。其他会议意见区域留给实际填写，不生成虚构会议记录。
- 尺寸与公差是数值，英寸支持分数显示；不推算缺少的尺码。
- 每个工作表明确打印区域，A4 一页宽、一页高，按内容选择横向或纵向。

当前模板适配这套十一页的工作表名称和栏目位置，自定义模板应使用相同布局。使用内置模板和 `.xlsx` 不需要安装 Excel；要打开导出的文件需要 Excel 或 WPS。旧 `.xls` 的自动转换需要已安装的 Microsoft Excel 或 LibreOffice，也可以先用 WPS 另存为 `.xlsx`。

## 模型与本地文件

PDF 在本机读取并渲染。点击识别后，PDF 页面图片及提取文字会发送到设置的模型服务。文件原件不覆盖，Excel 在本机生成。API Key 仅在主进程使用，选择记住时用系统加密保存，不写入 Excel、JSON 或应用日志。本地模型可通过兼容 Chat Completions 的服务地址连接。

实际识别准确性取决于模型和源文件，尤其需要核对尺寸、数量、颜色及唛头中的占位内容。

## 开发与打包

独立工程，Electron + Vue + TypeScript。PDF.js 读取和裁图；OOXML 局部编辑保留原模板的图片、样式及分页能力。模型支持 OpenAI Responses 的严格 JSON Schema，以及兼容 Chat Completions 的 JSON 返回。

```bash
npm ci
node node_modules/electron/install.js
node scripts/copy-pdf-assets.mjs
npm run dev
npm run check
npm run test:desktop
npm run package:win
```

需要 Node.js 22.16+。构建 Windows x64 NSIS 安装包使用 electron-builder 的原生 NSIS 工具集，不需要 Rosetta 或 Wine。使用 `signExecutable: false` 保留图标和版本信息编辑，当前交付包未配置商业代码签名证书。

测试覆盖：分数与数值尺寸、模板规则、不同款号和材料数量、缓存、密钥加密、API 结构及错误处理；桌面回归通过本机模拟 API 完整走通真实 7 页 PDF、核对、图片裁剪及 Excel 导出，不向云端发送测试资料。Windows 安装包静态检查与原生 Windows 安装运行是不同的验证步骤。

官方接口参考：

- https://developers.openai.com/api/docs/guides/images-vision
- https://developers.openai.com/api/docs/guides/structured-outputs
