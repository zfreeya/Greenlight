---
name: web-publish
description: 把一个已有的 HTML/Markdown 成果发布为可预览的网页。当用户要求"发布网页/生成报告页面/上线静态页"时使用。
license: MIT
allowed-tools:
  - write
  - read
  - glob
metadata:
  harness.version: "1"
  harness.publisher: "harness-examples"
  harness.capabilities: "web.publish asset.read"
---

# 网页发布助手

把用户提供的 Markdown 或 HTML 内容发布成一个可预览的静态网页。

## 流程

1. 用 `read` 读取用户指定的源文件（Markdown 或 HTML）。
2. 若源是 Markdown，先转成 HTML（用内联模板，标题/列表/代码块）。
3. 用 `write` 写入 `发布产物.html`，确保：
   - 视口 meta `width=device-width`；
   - 语义化结构（header/main/footer）；
   - 内联样式保持简洁，正文最大宽度 720px 居中。
4. 完成后提示用户「已在右侧预览打开」，并给出文件名。

## 约束

- 只生成单个自包含 HTML 文件，不引入外部 CDN 依赖。
- 不修改源文件。
