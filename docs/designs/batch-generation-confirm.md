# 设计：批量生成确认（O1 落地）

对应 OKR：O1 信任与注意力。本文档是实际设计，含交互、契约、边界与验收，不是愿景。

## 1. 问题

生成页现在的主操作是"生成下一个镜头"，每点一次弹一次确认面板。十个镜头就是十次打断，每次都要读一遍费用信息再点一次确认。用户要的是一次授权一批、队列自己跑、超限自动停。

同时存在一个平台事实（见 CEO 备忘附录）：火山方舟 Seedance 按次计费，接口不回传单次扣费金额，本地无法预估单价。所以任何"预计总费用 ¥XX"都是假数字。本设计不造假数字，用"新生成条数"做硬上限，这是产品真实知道且能承诺的量。

## 2. 目标

- 一次确认覆盖整批：面板说清楚"几个新生成、几个命中缓存（0 费用）、费用以服务端实际扣费为准"。
- 用户可设"本次最多新生成条数"，达到上限后剩余镜头本次不提交，不产生任何新调用。
- 缓存命中永远不占上限、不产生费用，这条照旧。
- 单镜头入口保留（分镜页/检查器），但生成页主路径是批量。

## 3. 交互流程

生成页：

1. 计算"未生成镜头"：无 clipAssetId，且没有 ready_for_review/selected/locked 的 Take。
2. 主按钮：批量生成剩余镜头（N）。
3. 点击后请求预览（generate_selected_shots，不带 confirmed），弹批量确认面板。
4. 面板确认后带 confirmed:true + batchCap 提交，队列开始跑。
5. 生成页下方队列实时显示任务状态；达到上限后不再有新任务出现。

批量确认面板内容：

- 汇总行：N 个新生成（费用以服务端实际扣费为准）· M 个命中缓存（0 费用）。
- 明细列表：镜头 ID | 新生成/缓存 | 时长 | 校验是否通过（blocked 的镜头标红并说明原因）。
- 上限输入：本次最多新生成条数，默认 = N，可调小（如先试 2 条看效果）。
- 提示文案（诚实，不加粗不煽情）：Seedance 按次计费，单条费用以服务端实际扣费为准；相同请求命中缓存不重复计费；达到上限后剩余镜头本次不提交，需要时再确认下一批。
- 按钮：取消 / 确认提交这批。

## 4. 服务端契约

### generate_selected_shots（预览 + 提交两用）

入参：projectId, provider（UI 传 seedance）, shotIds[]（可选；缺省时取服务端可生成镜头）, confirmed（可选）, batchCap（可选，本次最多新生成条数）, model/billing_mode 透传。

预览分支（confirmed !== true）：逐镜头走只读 previewGeneration（不创建任务、不写库、不调用生成 API），返回：

```
{
  ok: true, pending: true, shotIds,
  items: [{ shotId, generationKey, cacheHit, newGen, duration, blocked, validation }],
  newGenerationCount, cacheHitCount,
  batchCap: number | null,
  costDisclaimer: "Seedance 按次计费，服务端无法在本地预估单条费用，以实际扣费为准；命中缓存不产生新费用。",
}
```

提交分支（confirmed === true）：委托 confirm_generation（shotIds 数组 + batchCap）。

### confirm_generation 增加 batchCap

入参新增 batchCap（可选整数）。语义：本次调用中，新生成（非缓存、非复用）的任务创建数达到 batchCap 后，剩余镜头跳过，不创建任务、不调用生成 API。

返回新增：

```
{
  ...原有字段,
  skippedByCap: 2,          // 因达到上限未提交的镜头数
  batchCap: 3 | null,
  results: [..., { shotId, ok: false, code: "batch_cap", hint: "已到达本次批量上限，该镜头本次未提交" }],
}
```

实现要点：上限计数在 enqueueShotForGeneration 的创建点之前判断（缓存命中与 in-flight 复用路径提前返回，不占上限），保证"创建数 = min(新生成数, batchCap)"精确成立，且跳过时不产生任何副作用。

### 不做的

- 不在项目里新增批记录表/状态字段。batchCap 只作用于当次调用，队列照旧，不做跨批次记账。跨批次总量控制留给项目级 budgetLimit（另行设计，见边界）。
- 不显示任何金额估算。

## 5. 边界与诚实边界

- 缓存命中：不占上限、0 费用、直接复用已有资产。
- forceRegenerate：视为新生成，计入上限（它确实会产生新调用）。
- 校验失败（capability_rejected / blocked）：不计入上限，正常返回错误项。
- 失败/重试：任务失败只标记失败，不自动重试提交，不重复计费（沿用现有行为）。
- 金额：本版本不显示任何金额数字。未来若 worker 接入实时定价（arkcli-pricing 同类接口），再在面板加"按当前单价估算"并明确标注为估算，那时金额上限才有意义。
- 项目级上限：2026-08-26 已落地为 paidGenerationCap（付费新生成条数上限，真实执行；local-stub 免费不占额度；达到后新生成被拒绝，可 queue_control set_paid_cap 调整）。budgetLimit（金额）因平台不回传扣费数据无法执行，UI 如实标注"仅记录"。

## 6. 验收（可执行测试）

1. 服务端测试：确认后 engine 中该批新任务数 = min(新生成数, batchCap)。
2. 服务端测试：batchCap 小于新生成数时，返回 skippedByCap 正确、被跳过镜头无 task 行、无资产副作用。
3. 服务端测试：全部命中缓存时 batchCap 不拦截，全部复用。
4. 前端：生成页主按钮文案与禁用态随未生成镜头数变化。
5. 布局验收脚本三尺寸通过，批量确认面板无溢出。

## 7. 影响面

- 服务端：director-server.mjs 两个路由 + enqueueShotForGeneration 上限点；tools.mjs 两个工具 schema。
- 前端：GenerationPage 主操作、DirectorWorkspace 批量确认面板、director.ts 类型。
- 不改：SQLite schema、付费闸门、缓存逻辑、轮询循环。
