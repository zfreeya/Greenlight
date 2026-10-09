# 发布产物模板参考

Markdown 转 HTML 时，用下面的骨架包裹正文：

```html
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{{TITLE}}</title>
  <style>
    body { font-family: -apple-system, "PingFang SC", sans-serif; max-width: 720px; margin: 0 auto; padding: 24px; line-height: 1.7; }
    h1 { font-size: 1.6em; }
    pre { background: #f5f5f7; padding: 12px; border-radius: 8px; overflow-x: auto; }
  </style>
</head>
<body>
  <main>{{BODY}}</main>
</body>
</html>
```

`{{TITLE}}` 与 `{{BODY}}` 是替换占位符。
