# Harness Desktop

DeepSeek Harness 桌面端 - 对话式 Agent 工作台（Tauri 2 + React + TypeScript + Vite）。

**真实能力（无 mock，能力对齐 deepseek-harness 关键工具集）**：
- **真实 Agent 工具流**：模型自主调用 **bash / read / write / edit / glob / grep / fetch / todo_write**
  等真实工具（tools-server :8450 侧车执行），能浏览代码仓库、跑命令、读写文件，拿到真实结果再回答
- 对话引擎直连 **MemoryProxy(:8096) → DeepSeek 真实模型**：直接回答问题；信息不足才一次一问
  （[OPTIONS] 选项）；复杂任务先 todo_write 列计划再逐步执行
- **TencentDB Agent Memory** 真实记忆：MemoryCore(:8420) L0 对话沉淀 → L1 事实 → L2 场景 → L3 画像，新对话自动召回注入
- **会话持久化**：对话与任务清单落 localStorage，重开 App 不丢（含容量上限）
- **停止按钮**：长任务可随时中断（abort 模型等待与工具执行）；连续快速发送有同步竞态防护
- **线程状态流转**：空闲 → 执行中 → 已完成，「清空已完成对话」真实生效；模型选择与减弱动态效果均持久化
- 工具执行失败有错误态行 + 错误 toast；内置浏览器预览面板（右侧滑出）、⌘K 命令面板、真实窗口控制、任务清单卡与工具执行行渲染
- **Agent 回复 Markdown 渲染**：标题/列表/加粗/代码块/表格（GFM），原始 HTML 安全转义（防 XSS），链接在 Tauri 内用系统浏览器打开
- **工作目录预览（harness.local）**：agent 写出的 .html 网页/游戏自动在右侧预览面板打开并实时渲染，改完即刷新；标签可关闭、地址栏显示 /preview/ 路径
- **Godot 游戏能力（真实，不伪造）**：Godot 仅作为 Harness 内部的运行/渲染/校验/导出引擎；
  运行时检测（多路径扫描 + 手动选择 + 版本校验 + 诚实「未安装」状态）；项目创建/导入/解析/校验
  （真实生成 project.godot / 场景 / GDScript，解析场景节点树）；受控子进程运行/停止/重启（退出码分类、日志捕获）；
  结构化 Godot 工具（detect/select/create/inspect/run/stop/restart/validate/export/diagnostics…）；独立状态模型
  （engineStatus/gameStatus/projectStatus）；游戏工作区（游戏/场景/控制台）；任务类型（普通/网页/Godot 游戏/导入）。
  **已安装**：Godot 4.7.2（/Applications/Godot.app，经国内镜像安装）；真实运行/停止/日志/退出分类已端到端验证。
  **限制**：Web 导出模板未安装（Web 内嵌试玩仍报「模板缺失」）；运行时下载/自动更新通道留接口（当前用 Homebrew cask / 镜像直下）。
- **状态一致性与上下文隔离（四源状态模型）**：taskStatus / agentStatus / previewStatus / artifactStatus 独立驱动，
  界面任何区域的状态都来自对应状态源（顶栏任务状态、Agent 状态、成果卡预览状态、生成状态互不矛盾）；
  停止 Agent 不影响预览服务；成果卡按 正常/预览停止/内容过期/生成失败 分别呈现，主操作按状态唯一（确认完成/重新启动预览/重新加载/重试生成）；
  预览面板只显示当前任务标签（跨任务标签进历史计数），过期/停止时遮罩提示；工具调用默认折叠为人类可读摘要（已读取/已更新/已运行命令…）；
  推荐下一步按任务上下文生成（游戏任务≠普通页面）；三栏可拖拽分隔 + 专注对话/专注预览。
- **Agent 工作台式界面（任务管理—执行—交付—验收闭环）**：
  任务标题自动由交付物派生、可点击修改（侧栏/顶栏同一数据源）；八态状态系统由真实数据驱动
  （等待用户输入/执行中/等待用户授权/等待验收/执行失败/成果已就绪/用户已确认…，悬停有解释）；
  聊天顶部任务摘要（目标/状态/成果/预览状态/更新时间，滚动后收缩）；执行按用户请求合并为一组
  （人类可读动作摘要 + 步骤数 + 耗时，过去执行折叠为「此前执行」）；成果卡为一等对象
  （类型/文件/服务状态/地址/打开预览/浏览器打开/查看文件/更多菜单/更新时间，服务失效显示已停止+重新启动）；
  验收动作 chips（确认完成/继续修改/按上下文生成建议）；执行模式选择器（自动/执行前确认/仅计划）；
  预览面板 loading/错误态与「重新加载」；暖灰浅色视觉系统；窄窗口侧栏折叠；主阅读列约束

设计规范见仓库根目录 `DESIGN.md`；记忆技术设计见 `docs/MEMORY.md`；工具执行服务设计见 `docs/TOOLS.md`。

## Director 工作台（Seedance 导演生产系统）

`harness-desktop` 内置一套 AI 导演工作台（Harness Director），面向火山方舟 Seedance，
用 FFmpeg 做本地后期。创作层级 `Project → Scene → Shot → Take → Asset → Timeline → Render`，
核心目标是**可持续创作、不因每次小改动重复调用付费模型**。

**关键机制**（详见 `docs/seedance-director-architecture.md` / `docs/generation-state-machine.md`）：

- **Generation Spec + SHA-256 `generation_key` + SQLite 缓存**：相同请求命中缓存直接复用，
  不调用 API；网络重试不重复下单（幂等）。
- **Dirty 分离**：改 Prompt/参考 → 只标记该 Shot Generation dirty；改时间线/字幕/配乐/转场 →
  只标记 Render dirty（只跑 FFmpeg）。
- **Take 模型**：一个镜头多个 Take，重新生成永远新建 Take，不覆盖旧结果。
- **任务状态机**：`draft → awaiting_approval → queued → generating → succeeded/failed/cancelled →
  downloading → ready_for_review → selected → locked`，SQLite 持久化 + 重启恢复。
- **付费保护**：只有显式点击「生成镜头 / 重新生成新 Take / 生成选中镜头 / 批量生成」并经
  **确认面板**确认后才调用 Seedance；改项目名/镜头顺序/字幕/转场/音乐/时间线/打开项目/自动保存/
  编辑提示词/切预览比例/普通预览**绝不调用** Seedance。
- **Python sidecar**：`tools-server/director/seedance/worker.py` 经 JSON-RPC stdin/stdout 跑官方
  SDK，结构化参数，Agent Plan / Platform 通道隔离，失败不静默换通道。

**配置 Seedance（Agent Plan / Platform）**：

```bash
# 1) 安装 Python SDK（官方）
python3 -m venv .venv && source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install --upgrade "volcengine-python-sdk[ark]"

# 2) 开发环境 API Key（正式桌面端写入 macOS Keychain，见 docs/security.md）
export ARK_API_KEY="你的Key"
export SEEDANCE_BILLING_MODE="agent_plan"   # 或 platform
export SEEDANCE_MODEL="你的模型ID"           # 不写死，由设置页配置
```

**安装 FFmpeg（未安装时，仅返回计划，不默认改 shell 配置）**：

```bash
# 优先清华镜像，其次中科大，最后官方（不重复安装，不写 .zprofile，不改 Homebrew remote）
HOMEBREW_API_DOMAIN="https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api" \
HOMEBREW_BOTTLE_DOMAIN="https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles" \
brew install ffmpeg
```

**启动 Director 服务与测试**：

```bash
node tools-server/director-server.mjs --workspace ./workspace   # 127.0.0.1:8456
node --test tools-server/director/*.test.mjs                    # 全部单元 + 集成测试（离线，不调用付费 API）
RUN_PAID_E2E=1 PAID_E2E_CONFIRM=yes ARK_API_KEY=... \
  node --test tools-server/director/paid-e2e.test.mjs           # 真实付费冒烟（双门禁）
```

**macOS 开发启动 / 打包**：

```bash
npm install
npm run tauri dev          # 开发模式（devUrl http://localhost:1420）
npm run build              # 前端 tsc + vite build
npm run tauri build        # → src-tauri/target/release/bundle/macos/Harness.app
```

## 打包产物

```bash
npm run tauri build
# → src-tauri/target/release/bundle/macos/Harness.app
```

**单 .app 自包含**：应用包内含 Node 运行时 + MemoryCore + MemoryProxy + tools-server 全套源码与依赖，
启动时把三个服务注册为 **launchd 常驻服务**（`~/Library/LaunchAgents/dev.harness.memory-{core,proxy}.plist`
与 `dev.harness.tools.plist`，指向包内资源）：已健康则不动（秒开、不打断），不健康才修复，重启机器后自动拉起。
tools-server 的工作目录为 `~/Harness`（Agent 读写文件的根目录）。
DeepSeek API Key 已内置于包内配置（仅本机分发，请勿外传）。

## 开发模式

```bash
npm install
npm run tauri dev
```

## E2E 验证（真实链路，无 mock）

```bash
npx playwright test   # 45 用例：任务隔离（跨任务上下文）/ 状态一致（停止不伤预览）/ 任务闭环（四态/验收）/
                      # 真实 Agent 工具流 / 工作目录预览 /
                      # 工具折叠 / 成果卡 / 窄窗口 / 预览失败恢复 / 真实 LLM 对话 /
                      # [OPTIONS]/[PLAN] 协议 / 真实记忆召回与 L0 沉淀 / Markdown 渲染与 XSS 安全 /
                      # 会话持久化 / 竞态防护 / 停止中断 /
                      # 停止中断 / 持久化设置 / 错误可见性 / UI / 键盘 / 渲染
```

前置：本机记忆服务在跑（App 启动一次即可，或 `launchctl bootstrap gui/$(id -u) <plist>`）；
tools-server 由 playwright webServer 自动拉起（`npm run tools` 可手动启动）。

## 结构

```
src/
  main.tsx       入口
  App.tsx        全部 UI（含工具执行行 / 任务清单卡渲染）
  harness.tsx    真实 Agent 引擎：LLM 工具循环（tool_calls → tools-server 执行 → 回传）+ 会话持久化 + 记忆召回/沉淀
  memory.ts      MemoryCore 直连 + MemoryProxy LLM 转发（含 tools 透传）+ 本地回退
  state.ts       类型（无任何 mock 数据）
  styles.css     设计令牌 CSS 变量（与 DESIGN.md 一一对应）
tools-server/
  index.mjs      零依赖工具执行服务（bash/read/write/edit/glob/grep/fetch，工作目录沙箱）
src-tauri/
  tauri.conf.json
  resources/      打包资源：node 运行时 / memory-core / memory-proxy / tools-server / 配置模板
  src/lib.rs      setup 钩子：生成配置 + 拉起三个常驻服务
public/
  preview-demo.html / preview-docs.html   内置浏览器演示页
```

## 快捷键

Enter 发送 · Shift+Enter 换行 · ⌘K 命令面板 · ⌘N 新对话 · Esc 关闭浮层 · ⌘W 关窗