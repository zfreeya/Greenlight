# 生成任务状态机

## 状态集

```
draft → awaiting_approval → queued → generating → succeeded / failed / cancelled
                                                      ↓
                                                downloading
                                                      ↓
                                                ready_for_review
                                                      ↓
                                                   selected
                                                      ↓
                                                    locked
```

`tools-server/director/generation.mjs` 中 `TASK_STATES` / `TAKE` 生命周期共用同一状态机。

| 状态 | 含义 | 是否终态 |
|---|---|---|
| `draft` | 已创建，未提交审批 | 否 |
| `awaiting_approval` | 等待用户确认（付费提交前） | 否 |
| `queued` | 已批准，排队中 | 否 |
| `generating` | 已提交 Provider，轮询中 | 否 |
| `succeeded` | Provider 生成成功，尚未下载 | 否 |
| `failed` | 生成失败 | 是（除非新 Take） |
| `cancelled` | 已取消 | 是 |
| `downloading` | 正在下载结果 | 否 |
| `ready_for_review` | 已下载，等待审片/QC | 否 |
| `selected` | 已选为当前 Take | 否 |
| `locked` | 已锁定 | 是 |

## 迁移表

```
draft            → awaiting_approval | cancelled
awaiting_approval→ queued | draft | cancelled
queued           → generating | cancelled
generating       → succeeded | failed | cancelled
succeeded        → downloading | cancelled
downloading      → ready_for_review | failed | cancelled
ready_for_review → selected | cancelled
selected         → locked | ready_for_review
locked           → （无）
failed           → （无）
cancelled        → （无）
```

## 关键规则

1. **付费保护**：`compile_generation_spec` 只编译 Spec 并返回确认面板，绝不调用生成 API；
   只有 `confirm_generation`（`confirmed=true`）才真正入队。
2. **缓存优先**：`confirm_generation` 先查 `generation_key` 缓存，命中且文件存在则复用，
   不产生 API 调用。`forceRegenerate=true` 才跳过缓存强制生成新 Take。
3. **生成失败 vs 下载失败**：`error_kind` 区分两者。
   - `generation`：生成失败，重试 = 新 Take；
   - `download`：下载失败，只允许 `retry_download` 重试下载，**绝不重新生成**。
4. **幂等**：`GenerationEngine.createTask` 对同 `generation_key` 的非终态任务复用既有 `task_id`，
   网络重试 / 查询超时不会重复下单。
5. **轮询退避**：初始 3s，随重试指数增长，叠加 ±20% 随机抖动，上限 60s（`pollIntervalMs`）。
6. **重启恢复**：任务行持久化在 SQLite；`listInFlight` 返回 `draft/awaiting_approval/queued/
   generating/succeeded/downloading` 状态的未完成任务，后台轮询循环续跑。
7. **取消**：支持取消排队/生成中任务、删除远程任务记录、删除本地 Take（删除本地文件前需确认）。

## 持久化字段（SQLite `generation_tasks`）

`task_id`（主键）、`project_id`、`shot_id`、`take_id`、`generation_key`、`provider`、`model`、
`billing_mode`、`base_url`、`status`、`provider_job_id`、`retries`、`download_attempts`、
`last_poll_at`、`error`、`error_kind`、`created_at`、`updated_at`。
