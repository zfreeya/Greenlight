/* ============================================================================
 * Harness Director — 生成引擎（Generation Spec / 缓存 / Take / 任务状态机）
 *
 * 单一事实来源：本模块负责「任何一次真实视频生成」的标准化、去重、幂等与
 * 生命周期。目标：同样的请求绝不重复调用付费模型；网络重试绝不重复下单。
 *
 * 关键概念：
 *   - Generation Spec：标准化生成请求（provider/billing_mode/base_url/model/
 *     prompt/reference_asset_hashes/resolution/ratio/duration/generate_audio/
 *     watermark/return_last_frame/… + 模型其它参数）。对规范 JSON 求 SHA-256 得到
 *     generation_key。
 *   - Take：一个镜头可拥有多个 Take（多次生成/重新生成）。重新生成永远创建新
 *     Take，不覆盖旧结果。
 *   - Dirty 分离：Generation dirty（Prompt/参考素材改变 → 需要新生成）与
 *     Render dirty（时间线/字幕/配乐/转场改变 → 只需 FFmpeg 重渲染）完全独立。
 *   - 任务状态机：draft → awaiting_approval → queued → generating →
 *     succeeded/failed/cancelled → downloading → ready_for_review → selected → locked。
 *
 * 持久化：
 *   - 缓存与任务生命周期用 SQLite（node:sqlite，零外部依赖）落盘，键为
 *     generation_key / task_id；应用重启后恢复未完成任务，不重复创建 task_id。
 *
 * 本模块只做数据与状态，不做任何网络 I/O（Provider 调用由上层注入）。
 * ==========================================================================*/
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/* ---------------------------------------------------------------------------
 * 状态机
 * -------------------------------------------------------------------------*/
export const TASK_STATES = [
  "draft",             // 草稿（已创建，未提交审批）
  "awaiting_approval", // 等待用户确认（付费提交前）
  "queued",            // 已批准，排队中
  "generating",        // 已提交 Provider，轮询中
  "succeeded",         // Provider 生成成功，尚未下载
  "failed",            // 生成失败（terminal，除非新 Take）
  "cancelled",         // 已取消（terminal）
  "downloading",       // 正在下载结果
  "ready_for_review",  // 已下载，等待审片/QC
  "selected",          // 已选为当前 Take
  "locked",            // 已锁定
];

export const TASK_TERMINAL = new Set(["failed", "cancelled", "locked"]);

export const TASK_TRANSITIONS = {
  draft: ["awaiting_approval", "cancelled"],
  awaiting_approval: ["queued", "draft", "cancelled"],
  queued: ["generating", "cancelled"],
  generating: ["succeeded", "failed", "cancelled"],
  succeeded: ["downloading", "cancelled"],
  // 下载失败允许重试下载（由 error_kind === "download" 保证，见 retryDownload）
  downloading: ["ready_for_review", "failed", "cancelled"],
  failed: [],
  ready_for_review: ["selected", "cancelled"],
  selected: ["locked", "ready_for_review"],
  locked: [],
  cancelled: [],
};

export function canTransition(from, to) {
  return (TASK_TRANSITIONS[from] || []).includes(to);
}
export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new Error("非法任务状态迁移：" + from + " -> " + to);
}

/* 错误类型：区分「生成失败」与「下载失败」，下载失败绝不重新生成。 */
export const ERROR_KINDS = ["generation", "download", "validation", "network", "unknown"];

/* ---------------------------------------------------------------------------
 * 稳定 ID
 * -------------------------------------------------------------------------*/
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
function rand(len) {
  const bytes = crypto.randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

/** Take 稳定 ID（项目内可读分类 + 单调序号）。 */
export function newTakeId(projectId, seq) {
  return "TAKE-" + String(projectId).slice(0, 8) + "-" + String(seq).padStart(4, "0");
}
export function newTaskId(projectId, seq) {
  return "GEN-" + String(projectId).slice(0, 8) + "-" + String(seq).padStart(4, "0");
}

/* ---------------------------------------------------------------------------
 * SHA-256 / 文件哈希
 * -------------------------------------------------------------------------*/
export function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function fileSha256(absPath) {
  return sha256(fs.readFileSync(absPath));
}

/* ---------------------------------------------------------------------------
 * 规范 JSON（确定性序列化：对象键排序，数组保持顺序）
 * -------------------------------------------------------------------------*/
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const k of Object.keys(value).sort()) {
    const v = value[k];
    if (v === undefined) continue; // 忽略 undefined 以稳定哈希
    out[k] = canonicalize(v);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Generation Spec 标准化
 * -------------------------------------------------------------------------*/
/**
 * 把一次生成请求标准化为 Generation Spec。
 * 传入的 input 至少包含 provider/billing_mode/model/prompt/resolution/ratio/
 * duration/generate_audio/watermark/return_last_frame，以及 referenceAssets
 * （数组，每项含 assetId 与 sha256）。额外模型参数放进 extra。
 */
export function standardizeGenerationSpec(input = {}) {
  const refs = Array.isArray(input.referenceAssets) ? input.referenceAssets : [];
  const referenceAssetHashes = refs
    .map((r) => ({
      assetId: String(r.assetId ?? r.id ?? ""),
      role: String(r.role ?? "reference"),
      sha256: String(r.sha256 ?? r.hash ?? ""),
    }))
    .filter((r) => r.assetId || r.sha256)
    .sort((a, b) => (a.assetId + a.role).localeCompare(b.assetId + b.role));

  const spec = {
    provider: String(input.provider ?? ""),
    billing_mode: String(input.billing_mode ?? ""), // agent_plan | platform
    base_url: String(input.base_url ?? ""),
    model: String(input.model ?? ""),
    prompt: String(input.prompt ?? ""),
    negative_prompt: String(input.negative_prompt ?? ""),
    reference_asset_hashes: referenceAssetHashes,
    resolution: String(input.resolution ?? ""),
    ratio: String(input.ratio ?? ""),
    duration: Number(input.duration ?? 0),
    generate_audio: Boolean(input.generate_audio),
    watermark: Boolean(input.watermark),
    return_last_frame: Boolean(input.return_last_frame),
    seed: input.seed == null ? null : Number(input.seed),
    extra: canonicalize(input.extra && typeof input.extra === "object" ? input.extra : {}),
  };
  spec.key = generationKey(spec);
  return spec;
}

/** 对标准 Spec 的规范 JSON 求 SHA-256，作为 generation_key。 */
export function generationKey(spec) {
  const withoutKey = { ...spec };
  delete withoutKey.key; // key 是派生字段，不参与哈希
  return sha256(JSON.stringify(canonicalize(withoutKey)));
}

/* ---------------------------------------------------------------------------
 * Take 模型
 * -------------------------------------------------------------------------*/
export function newTake(seq, partial = {}) {
  const now = Date.now();
  return {
    takeId: partial.takeId || "",
    shotId: partial.shotId || "",
    index: partial.index ?? seq,
    status: partial.status || "draft",
    generationKey: partial.generationKey || "",
    spec: partial.spec || null,               // 完整 Generation Spec（含 key）
    provider: partial.provider || "",
    model: partial.model || "",
    taskId: partial.taskId || "",
    assetId: partial.assetId || "",
    // 下载成功后记录（用于缓存命中与完整性校验）
    fileHash: partial.fileHash || "",
    fileSize: partial.fileSize ?? null,
    width: partial.width ?? null,
    height: partial.height ?? null,
    duration: partial.duration ?? null,
    codec: partial.codec || "",
    sourceTaskId: partial.sourceTaskId || "",
    error: partial.error || null,
    errorKind: partial.errorKind || null,
    retries: partial.retries ?? 0,
    downloadAttempts: partial.downloadAttempts ?? 0,
    createdAt: partial.createdAt || now,
    updatedAt: partial.updatedAt || now,
  };
}

/* ---------------------------------------------------------------------------
 * Dirty 分离
 * -------------------------------------------------------------------------*/
/**
 * Prompt / 参考素材改变 → 只标记对应 Shot 为 Generation dirty。
 * 同时把该 Shot 已选 Take 的状态回退提示（不自动删旧 Take）。
 */
export function markGenerationDirty(shot, reason = "") {
  if (!shot.dirty) shot.dirty = {};
  shot.dirty.generation = true;
  shot.dirty.generationReason = reason || "";
  shot.dirty.generationAt = Date.now();
  shot.updatedAt = Date.now();
  return shot;
}

/**
 * 时间线/字幕/配乐/转场改变 → 只标记 Render dirty，不标记 Generation dirty。
 */
export function markRenderDirty(project, reason = "") {
  if (!project.renderDirty) project.renderDirty = {};
  project.renderDirty.flag = true;
  project.renderDirty.reason = reason || "";
  project.renderDirty.at = Date.now();
  project.updatedAt = Date.now();
  return project;
}

export function clearGenerationDirty(shot) {
  if (shot.dirty) { shot.dirty.generation = false; shot.dirty.generationReason = ""; }
  shot.updatedAt = Date.now();
  return shot;
}
export function clearRenderDirty(project) {
  if (project.renderDirty) project.renderDirty.flag = false;
  project.updatedAt = Date.now();
  return project;
}
export function isGenerationDirty(shot) { return Boolean(shot?.dirty?.generation); }
export function isRenderDirty(project) { return Boolean(project?.renderDirty?.flag); }

/* ---------------------------------------------------------------------------
 * GenerationEngine（SQLite 持久化：缓存 + 任务生命周期）
 * -------------------------------------------------------------------------*/
export class GenerationEngine {
  constructor(dbFile) {
    this.dbFile = dbFile;
    if (dbFile !== ":memory:") fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS generation_cache (
        generation_key TEXT PRIMARY KEY,
        asset_path     TEXT NOT NULL,
        file_hash      TEXT NOT NULL,
        file_size      INTEGER,
        width          INTEGER,
        height         INTEGER,
        duration       REAL,
        codec          TEXT,
        source_task_id TEXT,
        provider       TEXT,
        model          TEXT,
        created_at     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS generation_tasks (
        task_id           TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL,
        shot_id           TEXT NOT NULL,
        take_id           TEXT NOT NULL,
        generation_key    TEXT NOT NULL,
        provider          TEXT NOT NULL,
        model             TEXT NOT NULL,
        billing_mode      TEXT,
        base_url          TEXT,
        status            TEXT NOT NULL,
        provider_job_id   TEXT,
        retries           INTEGER NOT NULL DEFAULT 0,
        download_attempts INTEGER NOT NULL DEFAULT 0,
        last_poll_at      INTEGER NOT NULL DEFAULT 0,
        error             TEXT,
        error_kind        TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON generation_tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_key ON generation_tasks(generation_key);
    `);
    // 并发边界：非终态 (project_id, generation_key) 唯一约束（历史终态任务不阻止显式重新生成）。
    // 若旧库存在重复非终态行导致索引创建失败，仅告警不阻断（应用层 createTask 事务仍去重）。
    try {
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_tasks_active_generation_key
          ON generation_tasks(project_id, generation_key)
          WHERE status NOT IN ('failed','cancelled','locked','ready_for_review','selected');
      `);
    } catch (e) {
      process.stderr.write("[generation] 唯一索引创建失败（存在重复非终态任务）：" + String(e?.message ?? e) + "\n");
    }
  }

  /* ---- 缓存 ---- */
  /** 命中缓存：generation_key 已成功且本地文件存在。 */
  lookupCache(key) {
    const row = this.db.prepare("SELECT * FROM generation_cache WHERE generation_key = ?").get(key);
    if (!row) return null;
    if (!fs.existsSync(row.asset_path)) return null; // 文件缺失视为未命中
    return row;
  }

  recordCache(key, rec) {
    this.db.prepare(`
      INSERT OR REPLACE INTO generation_cache
        (generation_key, asset_path, file_hash, file_size, width, height, duration, codec, source_task_id, provider, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      key,
      String(rec.assetPath ?? rec.asset_path ?? ""),
      String(rec.fileHash ?? rec.file_hash ?? ""),
      rec.fileSize ?? rec.file_size ?? null,
      rec.width ?? null,
      rec.height ?? null,
      rec.duration ?? null,
      String(rec.codec ?? ""),
      String(rec.sourceTaskId ?? rec.source_task_id ?? ""),
      String(rec.provider ?? ""),
      String(rec.model ?? ""),
      Date.now(),
    );
    return this.lookupCache(key);
  }

  /* ---- 任务 ---- */
  /**
   * 幂等创建任务：若同 generation_key 存在非终态任务，直接返回既有任务，
   * 不重复创建（网络重试不会重复下单）。
   */
  createTask({ taskId, projectId, shotId, takeId, generationKey, provider, model, billingMode, baseUrl }) {
    // 并发边界：BEGIN IMMEDIATE 事务 + (project_id, generation_key) 非终态唯一索引。
    // 两个进程/窗口同时提交相同 Spec 时，只允许一次 Provider create；冲突方拿到既有任务。
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // 1) 同 key 的非终态任务 → 复用（ready_for_review 表示任务已完成，不算 in-flight，可重新下单）
      const existing = this.db.prepare(
        "SELECT * FROM generation_tasks WHERE generation_key = ? AND status NOT IN ('failed','cancelled','locked','ready_for_review','selected') ORDER BY created_at DESC LIMIT 1"
      ).get(generationKey);
      if (existing) {
        this.db.exec("COMMIT");
        return { task: existing, created: false, reused: true };
      }
      // 2) 同 task_id 已存在 → 复用
      const byId = this.db.prepare("SELECT * FROM generation_tasks WHERE task_id = ?").get(taskId);
      if (byId) {
        this.db.exec("COMMIT");
        return { task: byId, created: false, reused: true };
      }

      const now = Date.now();
      const task = {
        task_id: taskId, project_id: projectId, shot_id: shotId, take_id: takeId,
        generation_key: generationKey, provider, model,
        billing_mode: billingMode || "", base_url: baseUrl || "",
        status: "draft", provider_job_id: null, retries: 0, download_attempts: 0,
        last_poll_at: 0, error: null, error_kind: null,
        created_at: now, updated_at: now,
      };
      try {
        this.db.prepare(`
          INSERT INTO generation_tasks
            (task_id, project_id, shot_id, take_id, generation_key, provider, model, billing_mode, base_url, status, provider_job_id, retries, download_attempts, last_poll_at, error, error_kind, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          task.task_id, task.project_id, task.shot_id, task.take_id, task.generation_key,
          task.provider, task.model, task.billing_mode, task.base_url, task.status,
          task.provider_job_id, task.retries, task.download_attempts, task.last_poll_at,
          task.error, task.error_kind, task.created_at, task.updated_at,
        );
        this.db.exec("COMMIT");
        return { task, created: true, reused: false };
      } catch (e) {
        // 唯一约束冲突：另一个连接抢先创建了同 key 任务 → 回滚并返回既有任务
        this.db.exec("ROLLBACK");
        const winner = this.db.prepare(
          "SELECT * FROM generation_tasks WHERE generation_key = ? AND status NOT IN ('failed','cancelled','locked','ready_for_review','selected') ORDER BY created_at DESC LIMIT 1"
        ).get(generationKey) || this.db.prepare("SELECT * FROM generation_tasks WHERE task_id = ?").get(taskId);
        return { task: winner || task, created: false, reused: true };
      }
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  }

  getTask(taskId) {
    return this.db.prepare("SELECT * FROM generation_tasks WHERE task_id = ?").get(taskId) || null;
  }
  getTaskByTake(takeId) {
    return this.db.prepare("SELECT * FROM generation_tasks WHERE take_id = ?").get(takeId) || null;
  }
  /** 同 generation_key 是否存在未完成任务（用于防止双击/重复提交产生孤儿 Take）。 */
  findInFlightTask(generationKey) {
    return this.db.prepare(
      "SELECT * FROM generation_tasks WHERE generation_key = ? AND status IN ('draft','awaiting_approval','queued','generating','succeeded','downloading') ORDER BY created_at DESC LIMIT 1"
    ).get(generationKey) || null;
  }
  listTasks(projectId) {
    return this.db.prepare("SELECT * FROM generation_tasks WHERE project_id = ? ORDER BY created_at ASC").all(projectId);
  }
  /** 应用重启后需要恢复的未完成任务（排队/生成中/下载中/待审批）。 */
  listInFlight(projectId) {
    return this.db.prepare(
      "SELECT * FROM generation_tasks WHERE project_id = ? AND status IN ('draft','awaiting_approval','queued','generating','succeeded','downloading') ORDER BY created_at ASC"
    ).all(projectId);
  }

  /** 更新任务字段；status 迁移会做合法性校验（除非 force）。 */
  updateTask(taskId, patch, { force = false } = {}) {
    const cur = this.getTask(taskId);
    if (!cur) throw new Error("任务不存在：" + taskId);
    const next = { ...cur, ...patch, updated_at: Date.now() };
    if (patch.status && patch.status !== cur.status && !force) {
      assertTransition(cur.status, patch.status);
    }
    const stmt = this.db.prepare(`
      UPDATE generation_tasks SET
        project_id=?, shot_id=?, take_id=?, generation_key=?, provider=?, model=?,
        billing_mode=?, base_url=?, status=?, provider_job_id=?, retries=?,
        download_attempts=?, last_poll_at=?, error=?, error_kind=?, updated_at=?
      WHERE task_id=?
    `);
    stmt.run(
      next.project_id, next.shot_id, next.take_id, next.generation_key, next.provider, next.model,
      next.billing_mode, next.base_url, next.status, next.provider_job_id, next.retries,
      next.download_attempts, next.last_poll_at, next.error, next.error_kind, next.updated_at,
      taskId,
    );
    return this.getTask(taskId);
  }

  /** 记录一次轮询（last_poll_at 时间戳 + 递增重试计数，供退避计算）。 */
  touchPoll(taskId, { retryIncrement = false } = {}) {
    const cur = this.getTask(taskId);
    if (!cur) return null;
    return this.updateTask(taskId, {
      last_poll_at: Date.now(),
      retries: retryIncrement ? (cur.retries || 0) + 1 : cur.retries,
    }, { force: true });
  }

  /**
   * 轮询间隔：初始 3 秒，随重试指数退避，叠加随机抖动（±20%）。
   */
  pollIntervalMs(task, { baseMs = 3000, maxMs = 60000 } = {}) {
    const retries = task?.retries || 0;
    const exp = Math.min(maxMs, baseMs * Math.pow(2, retries));
    const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±20%
    return Math.round(exp * jitter);
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

export default GenerationEngine;
