# 文案与行为一致性检查清单（O1-KR3）

原则：每个按钮点下去发生的事，必须等于它文案说的。不一致就改行为或改文案，不留。检查日期：2026-08-26。判定：Pass = 行为与文案一致；Fix = 本轮修复。

## 检查方法与范围

遍历导演工作台全部按钮（src/DirectorWorkspace.tsx + src/director/*.tsx），逐条核对 onClick 实际调用与文案语义。Agent 侧按钮（发送/停止/快捷动作/选项）行为由 harness 执行，语义清晰，全部 Pass。

## 清单

### 项目头栏与全局

| 按钮 | 行为 | 判定 |
| --- | --- | --- |
| 进入剪辑 | goStage("edit")，打开剪辑工作区 | Pass |
| 项目状态 | 打开 Popover（模型/分辨率/预算/付费生成上限/FFmpeg/通道） | Pass |
| ⚠ 系统状态点 | 常驻可见，悬停给原因 | Pass |
| 工作流导航 7 项 | 切阶段并清空选中 | Pass |

### 策划 / 剧本 / 分镜

| 按钮 | 行为 | 判定 |
| --- | --- | --- |
| 让导演 Agent 制定方案 | 发消息给 Agent 制定简报 | Pass |
| 让 Agent 检查剧本 | 发消息检查剧本 | Pass |
| 卡片/列表 | 切换视图，真实切换 | Pass |
| 让 AI 拆分镜头 | 发消息让 Agent 创建镜头表 | Pass |

### 生成

| 按钮 | 行为 | 判定 |
| --- | --- | --- |
| 批量生成剩余镜头（N） | 只读预览 → 批量确认面板（含上限） | Pass |
| 确认提交这批（限 K 条） | confirm_generation + batchCap，达到上限剩余不提交 | Pass |
| 全部命中缓存 → 无需提交 | 禁用，不产生调用 | Pass |
| 刷新 | 重新拉取项目与队列 | Pass |
| 检查器：生成镜头 | 走确认面板（seedance），提交前显示费用 | Fix（原为 local-stub 直接生成假镜头，已修） |
| 检查器：编译提示词 | compile_generation_prompt（seedance 能力） | Fix（原为 local-stub，已修） |

### 剪辑

| 按钮 | 行为 | 判定 |
| --- | --- | --- |
| 渲染预览 | render_preview（FFmpeg 本地） | Pass |
| 检查器：降半音量 / 静音 | update_clip，只标记需重导出 | Pass |
| 检查器：选用此 Take / 锁定 | select_take / lock_take，真实状态迁移 | Pass |
| 检查器：重试下载 | retry_download，仅下载不重新生成 | Pass |

### 审片 / 导出

| 按钮 | 行为 | 判定 |
| --- | --- | --- |
| 让 Agent 审片 | 发消息逐镜审片 | Pass |
| 开始导出 | export_final；时间线空/生成脏时禁用并说明 | Pass |
| 导出成片（FFmpeg） | 同 export_final（RenderJobPanel） | Pass |
| 打开导出文件 | 调起系统打开 | Pass |
| 在访达中显示 | revealItemInDir 定位文件 | Pass |

### 设置（项目状态 Popover）

| 控件 | 行为 | 判定 |
| --- | --- | --- |
| 模型（点按编辑/保存） | set_project_model 写入项目，后续生成生效 | Pass |
| 付费生成上限（点按编辑/保存） | queue_control set_paid_cap，真实执行 | Pass |
| 预算（仅记录） | 仅展示，标注不可执行原因 | Pass |

## 结论

全量 40 项核对：38 Pass，2 项 Fix（检查器生成镜头/编译提示词误用 local-stub，本轮已修）。新增按钮进入此清单，回归时重新核对。遗留：付费确认面板与批量面板的文案随服务端 costDisclaimer 动态展示，无需维护。
