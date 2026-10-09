# 导演助理设计审查：第二轮（2026-08-26）

> 审查方式：只读真实代码（director-server.mjs / prompt-compiler.mjs / generation.mjs /
> qc.mjs / ffmpeg.mjs / tools.mjs / phases.tsx / AgentDrawer.tsx / DirectorWorkspace.tsx /
> director.ts），对照 docs/okr.md 与 docs/designs/reverse-workflow.md。
> 本轮聚焦"设计问题"，不是又一遍技术审计（技术审计见 director-harness-review.md）。

## 结论一句话

工程层已经非常扎实，真正的问题都在"产品语义"层：系统能生成一致的镜头，但
**一致性的世界状态没有闭环**，检查结果不反馈进生成，尾帧衔接全靠手动，产品锚点
（产品卡）之前根本不存在。这些正是 06-VideoContext 里设计过、但没落到代码里的东西。

## 本轮已修复（随 O2-KR2 实现一并落地）

| 编号 | 问题 | 证据 | 修复 |
|---|---|---|---|
| P-D1 | 连续性检查按镜头 index 排序，不跟时间线走。用户重排时间线后，检查的仍是旧顺序，结果与成片不符 | director-server.mjs `/continuity_check` 原 `.sort((a,z)=>(a.index\|\|0)-(z.index\|\|0))` | 改为时间线 clip 顺序优先（clip.start），时间线为空回退 index；返回 `orderBasis: timeline\|shot_index` |
| P-D2 | 连续性检查结果不绑定 Take 版本。换 Take 后结果过期，UI 无提示 | pairs 只有 shotIdA/shotIdB | 每对记录 takeIdA/takeIdB，CSV 同步加两列 |
| P-D3 | 产品模板只建镜头，不建产品资产卡。07 保温杯单里"同一个杯子"没有锚点，产品一致性无从谈起 | `/create_shot_list_from_template` 原只 push shots | 模板同时建 `bible.characters` 产品角色卡（immutableTraits 含"产品外观跨镜头保持一致"），每个镜头 `continuityAnchors` 引用该角色 ID，返回 productCharacterId |
| P-D4 | O2-KR2 反向工作流（先出画面再补设定）设计稿存在、完全未实现 | docs/designs/reverse-workflow.md 状态"未实现" | 实现 import_user_video / sample_frames / reverse_storyboard 三路由 + 三工具 + UI（分镜页空状态"从已有视频开始" + 帧网格反推面板）；测试 reverse-workflow.test.mjs 通过 |

## 仍未修的设计问题（按影响排序）

### P-D5 世界状态没有闭环（最重）

生成 → 检查 → 差异记录 → 反馈进后续生成的链路断了。`continuity_check` 输出只写
`p.continuityChecks` 供展示；`buildShotPacket` 里的 continuity 只来自 Agent 手工写的
`bible.continuity`；上一镜末帧要手动 `extract_last_frame` + `use_as_first_frame` 两步
才进下一镜。

后果：跨镜头一致性依赖人每步手工搬，系统不会自动滚雪球。这正好是
video-plan/06-VideoContext 里"世界状态演进"缺失的那块：没有 recent_shots、没有
history_issues、没有生成后自动更新上下文。

建议（下一轮）：把差异清单结构化（category/severity/source/fix 字段，对应
video-plan/04 schema），检查后自动把"上一镜末帧 + 差异"写进下一镜的生成上下文，
但改变 generation key 必须弹确认，不能静默改。

### P-D6 双 ID 系统 + characterRef 命名误导

角色卡同时有 `characterId`（CHAR-001）和 `stableId`（B-CHAR-001）两套 ID；
`shot.keyframes.characterRef` 语义是"参考资产 ID"（`referenceHashes` 当 assetId 查
assets），名字却叫 characterRef，极易被 Agent 误填成角色卡 ID，导致查不到资产、
参考静默丢失。

建议：字符校验层明确 characterRef 只能是资产 ID，误填返回明确报错而不是静默丢。

### P-D7 检查器阈值是魔法数字，无校准入口

luma>12 / rgb>24 / hist>0.4 是写死的初始假设。OKR O4 说"用真实数据校准"，但没有
收集"机器判定 vs 人眼判定"的数据结构，无法校准。

建议：CSV 增加 human_verdict 列（用户可改），攒够样本再调阈值。

### P-D8 尾帧衔接只有手动两步，没有一键链路

`extract_last_frame` + `use_as_first_frame` 存在且正确，但"多镜头衔接流畅"是产品
的核心承诺，不应该要求用户每镜手动搬两次。建议加"尾帧自动推进"开关（默认关，
开启后每镜确认时自动把上一镜末帧设为下一镜首帧参考；因改变 generation key，默认关
是对的）。

### P-D9 budgetLimit 只记录不执行（诚实边界，非缺陷）

平台不回传扣费金额，按条数上限执行是唯一诚实可执行的总闸。UI 已如实标注"仅记录"。
保留现状。

### P-D10 /health 暴露 workspace 绝对路径

本地单机工具可接受；若产品化需脱敏。

### P-D11 当前镜头 Shot Packet 标记为 trusted

prompt-compiler.mjs 第 8 节把 shot packet 标 trusted:true。shot 字段由 Agent 写入，
属于可信写入方，风险低，但严格说应标"半可信"（Agent 输出也算模型输出）。暂不改，
记录在案。

## 对照 OKR 的实现状态

- O1：KR1/KR2/KR3 已完成（进展记录见 docs/okr.md）。
- O2：KR1 已完成（阶段软闸门）；**KR2 本轮实现**；KR3（90 天 3 次真实走链 +
  碍事点清单）是使用者动作，工具侧已就绪，需在使用中产出 docs/reviews 记录。
- O3：KR1/KR2/KR3 已完成。
- O4：工具使能（检查器 v0 / 模板 / 记账）已就绪，本轮加固（P-D1/D2/D3）；
  业务动作（约客户、收款、转介绍）由使用者本人执行。

## 回归

- director 全部测试：55 pass，0 fail，1 skip（paid-e2e 按设计跳过）；
  reverse-workflow.test.mjs 新增 2 项通过。
- `tsc --noEmit` 0 错。
- seedance.test.mjs 超时为本机无 SDK 环境问题，与本轮改动无关（未触碰 seedance/）。
