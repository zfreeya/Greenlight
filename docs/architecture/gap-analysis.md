# Harness 桌面端内部架构差距分析

> 目标：在现有 `harness-desktop` 中落地「Agent Skills / MCP / Agent Runtime / Plugin / 权限审批 /
> 会话状态 / 任务恢复 / 第三方能力安装 / 可观察性」的能力系统。
> 本文先回答「现状有什么、缺什么」，作为改造基线。

## 0. 直接结论：当前有没有「读取 Skill」的能力？

**没有。** `harness-desktop` 目前**不读取任何本地 Agent Skill（`SKILL.md` 标准）**。证据如下：

- 前端 `src/`、`tools-server/`、`src-tauri/src/` 中没有任何 `SKILL.md` 解析、
  Frontmatter 解析、Skill Registry、渐进式加载、allowed-tools、Capability 相关代码。
- Agent 的「能力」是两处**硬编码**：
  1. `src/harness.tsx` 里的 `SYSTEM_PROMPT` 常量（字符串拼接的规则）；
  2. `src/harness.tsx` 里的 `buildTools()` 常量（约 37 个工具的 JSON Schema 手写清单）。
- 唯一出现 `skill` 字样的地方是**记忆系统的云端 Skill 能力**，与目标标准无关：
  - `src-tauri/resources/config/tdai-gateway.tpl.yaml` 的 `skill:` 段（bm25 路由/抽取）；
  - `src-tauri/resources/memory-proxy/src/injection/injectors/skill-injector.ts`：
    注入 `<available_skills>` 文本块，数据来自 MemoryCore 的 `/v3/skill/listing`（团队/Agent 维度、云端、curl 桥 `skill_view`/`skill_patch`）。
  - 这是 **TencentDB Agent Memory（TDAI）的知识型 Skill**，不是 agentskills 的本地目录型
    `SKILL.md` 标准；既不由桌面端安装/管理，也没有渐进式披露与本地文件校验。

因此改造目标是「从零引入」本地、开放标准的 Agent Skills 能力，而非在现有 Skill 上修补。

## 1. 现有技术栈盘点

| 层 | 现状 |
|---|---|
| 桌面框架 | **Tauri 2**（`src-tauri/`，Rust shell），非 Electron |
| 主进程 | `src-tauri/src/lib.rs`：写 launchd plist 并拉起 4 个 Node 常驻服务；含硬编码 `DS_KEY` |
| 渲染进程 | React 18 + Vite + TypeScript（`src/`），单窗口 |
| 后端服务（Node） | 4 个独立 HTTP 服务，由 Tauri 以 launchd 常驻：memory-core `:8420`、memory-proxy `:8096`、tools-server `:8450`、godot-server `:8455` |
| 模型 Provider | 经 **MemoryProxy**（OpenAI 兼容 `/chat/completions`，模型 `deepseek-chat` / `deepseek-v4-pro` / `deepseek-v4-flash`），Key 由 MemoryCore 网关侧持有 |
| Tool Calling | 手写 OpenAI function 格式 tool 清单，模型返回 `tool_calls`，前端 `execTool()` 分发到 tools-server/godot-server |
| 数据库 | **无**。会话/配置全部 `localStorage` |
| 状态管理 | `src/state.ts` 的 React state + 模块级常量；`useHarness()` 一个巨型 hook 承载 Agent 循环 |
| 会话 | `Thread`（id/title/msgs/todos/deliverables/status/agent），`localStorage` 序列化，无版本、无迁移、无恢复 |
| Agent 循环 | `harness.tsx` `sendMessage()`：单线程 for 循环（`MAX_STEPS=12`），无子 Agent、无暂停/恢复、无人工审批（仅 `[PLAN]` 文本解析出 `waiting_for_approval`） |
| 项目工作区 | tools-server `WORKSPACE`（打包版固定 `~/Harness`），fs 工具沙箱化，bash 可逃逸 |
| 权限系统 | **无**。仅 `ExecMode`（auto/confirm/plan-only）三档全局开关；`confirm` 模式并未真正实现（代码里没有逐工具审批，只是把 plan-only 与 auto 区分） |
| 文件系统 | tools-server 内置 `resolveInWorkspace` 路径校验（fs 工具），无符号链接逃逸防护 |
| 进程管理 | launchd（macOS）+ 孤儿进程兜底；无 MCP server 子进程生命周期管理 |
| Secret 存储 | **明文**：`DS_KEY` 硬编码在 `lib.rs`；`userKey` 存 localStorage；配置 YAML 明文写 Key |
| OAuth | **无** |
| 插件系统 | **无**（`@tauri-apps/plugin-*` 仅是 Tauri 原生能力插件，非 Harness 插件） |
| 预览与 Artifacts | 有：tools-server `/preview` 静态服务 + `Deliverable` 一等对象 + 预览四态 |
| 日志 | 仅 `console.log`/`println!`；工具事件存内存 `toolEvents` + `window.__toolEvents`，无结构化、无持久化 |
| 自动更新 | **无** |
| 跨平台打包 | 仅 macOS `.app`（`bundle.targets: ["app"]`，launchd 依赖），无 Windows/Linux 路径 |
| 测试体系 | Playwright e2e（`e2e/01..13`，13 个 spec）；**无单元测试**、无集成测试、无安全测试 |

## 2. 逐项能力差距

### 2.1 Agent Skills（目标：agentskills SKILL.md 标准）

| 需求 | 现状 | 差距 |
|---|---|---|
| SKILL.md 解析 | 无 | 缺失 |
| YAML Frontmatter（name/description/license/compatibility/metadata/allowed-tools） | 无 | 缺失 |
| description 触发 / 渐进式披露（三级加载） | 无（SYSTEM_PROMPT 全量注入） | 缺失 |
| references/scripts/assets | 无 | 缺失 |
| 安装来源（folder/ZIP/Git URL） | 无 | 缺失 |
| 路径穿越/符号链接逃逸防护 | 无 | 缺失（安装解包完全空白） |
| 版本化安装目录 / 更新索引 | 无 | 缺失 |
| Skill 状态机（discovered/installed/enabled/quarantined…） | 无 | 缺失 |
| 全局级 / 项目级作用域 | 无 | 缺失 |
| 信任等级（official/verified/community/local/untrusted） | 无 | 缺失 |

### 2.2 MCP

| 需求 | 现状 | 差距 |
|---|---|---|
| MCP Client（官方 `@modelcontextprotocol/sdk`） | 无 | 缺失 |
| stdio / Streamable HTTP transport | 无 | 缺失 |
| Tools / Resources / Prompts 发现 | 无 | 缺失 |
| 能力协商 / 服务端通知 / 重连 / OAuth | 无 | 缺失 |
| MCP Server 生命周期（进程管理/健康检查/日志/崩溃重启） | 无（launchd 只服务自有 4 个服务） | 缺失 |
| 「连接≠全量暴露工具」作用域 | 无 | 缺失 |
| Secret 入 Keychain（非明文） | 无（明文） | 缺失 |

### 2.3 Agent Runtime

| 需求 | 现状 | 差距 |
|---|---|---|
| Tool Calling 循环 | 有（`sendMessage` for 循环） | 需重构为可取消/暂停/恢复/持久化的 Run 状态机 |
| 任务状态 | 有 8 态（task）+ Agent 6 态 | 与需求状态集不匹配（缺 waiting_for_external_job/paused 等） |
| 取消 | 有（AbortController + stopRequestedRef） | 保留 |
| 重试 | 仅网络错误 8 次重试 | 缺失（无工具级安全重试策略） |
| 暂停 / 恢复 | 无 | 缺失 |
| 人工确认（逐工具审批） | 无（`confirm` 模式是死代码） | 缺失 |
| 子 Agent | 无 | 缺失 |
| 使用量 / 费用 / 错误分类 / 事件流 | 无 | 缺失 |
| 持久化 | localStorage 仅会话快照 | 缺失（无 Run 级持久化、无重启恢复） |

### 2.4 Plugin / Agent Definition

| 需求 | 现状 | 差距 |
|---|---|---|
| Plugin Manifest（plugin.json） | 无 | 缺失 |
| Agent Definition（agentId/modelPolicy/skills/capabilities/permissionPolicy…） | 无（只有「模型 + 执行模式」两个设置） | 缺失 |
| CapabilityRegistry（能力抽象 → Provider 绑定） | 无（工具名写死） | 缺失 |
| PermissionBroker（分级/授权/撤销/审计） | 无 | 缺失 |
| Hooks / UI Contributions / Migrations | 无 | 缺失 |

### 2.5 可观察性与调试

| 需求 | 现状 | 差距 |
|---|---|---|
| Run Inspector（时间线/Skill 激活/工具调用/审批/Token/费用） | 无（仅 `__toolEvents` 调试钩子） | 缺失 |
| Skill 激活原因 / 读取的参考 / 请求的 Capability | 无 | 缺失 |
| MCP 连接状态/启动日志 | 无 | 缺失 |

## 3. 关键架构约束（决定实现落点）

1. **主进程是 Tauri(Rust)，但业务后端是 Node**。MCP/Skill 文件操作/进程管理应放在
   **Node 侧**（`tools-server` 扩展或新增 `capabilities-server`），前端只做编排与 UI。
   符合用户要求「主进程是 TypeScript/Node 时优先用官方 MCP SDK」。
2. **模型经 MemoryProxy 转发**，前端以 OpenAI 兼容协议传 `tools`。MCP 工具可转成 OpenAI
   function 格式后并入 `buildTools()` 的动态结果，无需改动 Proxy。
3. **现有 Agent 循环集中在一个 hook**（`harness.tsx` `useHarness`）。为控制爆炸半径，
   第一阶段不重写 UI，而是把「Skill 路由 / Capability 绑定 / 权限过滤 / 工具集构造」
   收敛为纯函数/服务模块，再接入循环。
4. **无数据库**。Run 持久化先落地为 JSON 文件（经 Node 后端写入 App 数据目录），
   迁移层同时保留 localStorage 旧会话可读。
5. **跨平台现状**：仅 macOS launchd。新能力（Skill/MCP 安装、进程管理）在 Node 侧实现，
   不新增 launchd 依赖，天然跨平台；Tauri 打包跨平台留待后续阶段。

## 4. 迁移映射（用户要求「不破坏旧功能」）

| 现有能力 | 迁移为 |
|---|---|
| 内置 SYSTEM_PROMPT 规则 | Built-in Skill（`harness-core` 官方信任等级） |
| 普通工具（bash/read/write/edit/glob/grep/fetch/todo_write） | Local Capability Provider |
| Godot 工具集 | Local Capability Provider（Godot 域） |
| 外部工具 | MCP Provider |
| 固定角色 harness-agent | 默认 Agent Definition |
| 记忆召回/沉淀 | 保持现有 Memory 集成，作为 Agent 的 memoryPolicy 输入 |
| 旧 Thread（localStorage） | 迁移层保留可读，新 Run 记录并存 |

## 5. 改造顺序（与用户二十节一致，压缩为 5 阶段）

1. **Skill 底座**：SkillRegistry + SkillLoader（SKILL.md/Frontmatter/渐进式）+ 安装（folder/ZIP/git）+ 路径安全 + 管理 UI。
2. **MCP 底座**：官方 SDK + stdio + Streamable HTTP + Tools/Resources/Prompts + 管理 UI。
3. **编排与安全**：CapabilityRegistry + PermissionBroker + 会话 Tool Set + Run Inspector + Prompt Injection 防御。
4. **组合与分发**：Agent Definition + Plugin Manifest + Hooks + UI Contributions。
5. **持久与恢复**：持久工作流 + 人工确认 + 子 Agent + 异步任务恢复 + 成本/可观察性。

每阶段以真实端到端验证收口，不先堆空组件。MVP 最小闭环：
**标准 Skill 安装 → MCP 连接 → 权限审批 → 实际工具调用 → Artifact 交付**。

## 6. 已发现的安全问题（改造中一并处理）

1. **硬编码 API Key**：`src-tauri/src/lib.rs:10` 的 `DS_KEY` 明文进源码与 plist 环境变量。
2. **Secret 明文**：`userKey` 存 localStorage；配置 YAML 明文写 Key。
3. **tools-server CORS `*`**：仅监听 127.0.0.1，风险有限，但应收敛。
4. **bash 可逃逸工作目录**（当前有意为之）：引入权限分级后，bash 归 Level 1/2，需审批与确认。
