/* ============================================================================
 * Harness Director — Seedance Provider（Node 侧适配器）
 *
 * 不在 UI 渲染进程里运行 SDK：本模块以受管子进程方式拉起 Python sidecar worker
 * （tools-server/director/seedance/worker.py），通过 JSON-RPC stdin/stdout 通信。
 * stdout 只承载协议 JSON；worker 的诊断日志写 stderr。
 *
 * 该 Provider 实现统一 VideoGenerationProvider 接口（异步）：
 *   create_task / get_task / list_tasks / cancel_or_delete_task / download_result
 * 并适配到本仓库既有 providers.mjs 的 submit/poll/cancel/download 形状。
 *
 * 安全：
 *   - API Key 由 worker 从环境变量 ARK_API_KEY 读取（正式桌面端由 Keychain 注入），
 *     本模块不接触 Key；日志脱敏由 worker 负责。
 *   - billing_mode 决定 base_url；Agent Plan 失败绝不静默切到 Platform。
 * ==========================================================================*/
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKER = path.join(__dirname, "worker.py");

export const SEEDANCE_CHANNELS = {
  agent_plan: "https://ark.cn-beijing.volces.com/api/plan/v3",
  platform: "https://ark.cn-beijing.volces.com/api/v3",
};

/** 探测可用的 Python：项目 .venv（开发）→ brew python3.12（内嵌 site-packages 为 cp312）→ PATH python3。 */
function detectPython() {
  const candidates = [
    path.join(process.cwd(), ".venv", "bin", "python"),
    path.join(process.cwd(), ".venv", "bin", "python3"),
    "/opt/homebrew/bin/python3.12",
    "/usr/local/bin/python3.12",
    "python3",
  ];
  for (const c of candidates) {
    try {
      if (c === "python3") return c; // PATH 查找由 spawn 处理
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return "python3";
}

/** 打包版内嵌 SDK 依赖目录（resources/python-site-packages），存在则注入 PYTHONPATH。 */
function bundledSitePackages() {
  const p = path.join(__dirname, "..", "..", "..", "python-site-packages");
  return fs.existsSync(p) ? p : null;
}

/**
 * @param {object} opts
 * @param {string} [opts.pythonCmd]   python3 可执行文件
 * @param {string} [opts.workerPath]  worker.py 路径（测试可替换为 mock）
 * @param {string} [opts.billingMode] 默认消费通道 agent_plan | platform
 * @param {string} [opts.model]       默认模型 ID（设置页配置，不写死）
 */
export class SeedanceWorkerProvider {
  constructor(opts = {}) {
    // 优先使用显式 pythonCmd；否则探测项目 .venv（含 SDK），最后回退 PATH 中的 python3
    this.pythonCmd = opts.pythonCmd || detectPython();
    this.workerPath = opts.workerPath || DEFAULT_WORKER;
    this.billingMode = opts.billingMode || "platform";
    this.model = opts.model || "";
    this._proc = null;
    this._nextId = 1;
    this._pending = new Map();
    this._buf = "";
    this._disposed = false;
    this._capsCache = null;
  }

  /* ---- 进程管理 ---- */
  _ensureProc() {
    if (this._proc && !this._proc.killed) return this._proc;
    const env = { ...process.env };
    const site = bundledSitePackages();
    if (site) env.PYTHONPATH = site + (env.PYTHONPATH ? path.delimiter + env.PYTHONPATH : "");
    this._proc = spawn(this.pythonCmd, [this.workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this._buf = "";
    this._proc.stdout.on("data", (chunk) => this._onStdout(chunk.toString()));
    this._proc.stderr.on("data", (chunk) => {
      // 诊断日志转发到本进程 stderr（不进入协议 stdout）
      process.stderr.write("[seedance-worker] " + chunk.toString());
    });
    this._proc.on("error", (e) => {
      for (const [, p] of this._pending) p.reject(new Error("worker 启动失败：" + e.message));
      this._pending.clear();
    });
    this._proc.on("close", () => {
      for (const [, p] of this._pending) p.reject(new Error("worker 进程已退出"));
      this._pending.clear();
      this._proc = null;
    });
    return this._proc;
  }

  _onStdout(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this._pending.get(msg.id);
      if (p) {
        this._pending.delete(msg.id);
        // 一律交给调用方解析：业务级 ok:false（如能力校验拒绝）由 _rpcRaw 原样返回，
        // 需要失败语义的 _rpc 在其 resolve 回调中按 rejectOnOkFalse 抛错。
        p.resolve(msg);
      }
    }
  }

  /** JSON-RPC 调用：业务 ok:false 一律视为调用失败（抛错）。 */
  _rpc(method, params = {}, timeoutMs = 600000) {
    return this._rpcRaw(method, params, timeoutMs, { rejectOnOkFalse: true });
  }

  /** JSON-RPC 原样返回：业务 ok:false（如能力校验拒绝）也完整返回，便于上层读取结构化错误。 */
  _rpcRaw(method, params = {}, timeoutMs = 600000, { rejectOnOkFalse = false } = {}) {
    if (this._disposed) return Promise.reject(new Error("provider 已销毁"));
    const proc = this._ensureProc();
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error("seedance worker 超时：" + method));
      }, timeoutMs);
      this._pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          if (m.ok === false && rejectOnOkFalse) reject(new Error(m.error || "seedance 调用失败"));
          else resolve(m);
        },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  /* ---- 能力 / 模型 / 成本 ---- */
  async getCapabilities() {
    if (this._capsCache) return this._capsCache;
    try {
      const r = await this._rpc("capabilities", {}, 15000);
      this._capsCache = {
        name: "seedance",
        displayName: "火山方舟 Seedance（Python sidecar）",
        textToVideo: r.textToVideo, imageToVideo: r.imageToVideo, firstLastFrame: r.firstLastFrame,
        referenceImage: r.referenceImage, referenceVideo: r.referenceVideo, referenceAudio: r.referenceAudio,
        maxDuration: r.maxDuration, aspectRatios: r.aspectRatios, resolutions: r.resolutions,
        supportsAudio: r.supportsAudio, watermark: r.watermark, returnLastFrame: r.returnLastFrame,
        supportsSeed: r.supportsSeed, negativePrompt: r.negativePrompt,
        channels: r.channels, concurrencyLimit: 1,
        pricing: { unit: "按次计费", perClip: "以服务端实际扣费为准" },
        timeoutMs: 600000,
        async: true,
        billingMode: this.billingMode,
        model: this.model,
        honest: "真实 AI 生成（火山方舟 Seedance）。付费调用需用户逐次确认；Agent Plan 失败不会静默切到 Platform。",
      };
      return this._capsCache;
    } catch {
      return {
        name: "seedance", displayName: "火山方舟 Seedance（不可用）",
        textToVideo: true, imageToVideo: true, firstLastFrame: true,
        maxDuration: 12, aspectRatios: ["16:9", "9:16", "1:1"], supportsAudio: true,
        concurrencyLimit: 1, pricing: { unit: "按次计费", perClip: "以服务端实际扣费为准" },
        timeoutMs: 600000, async: true, available: false,
        billingMode: this.billingMode, model: this.model,
        honest: "Seedance worker 不可达或 SDK 未安装。",
      };
    }
  }

  getModels() {
    // 模型 ID 不写死：由设置页配置并注入 opts.model；能力矩阵由 worker 声明。
    return this.model ? [{ id: this.model, version: this.model }] : [];
  }

  estimateCost() {
    return { currency: "CNY", amount: null, range: "以服务端实际扣费为准", note: "Seedance 按次计费，无法在本地精确预估，提交前以确认面板为准。" };
  }

  /** 按模型族获取能力（worker 为单一事实来源；Node 端缓存）。 */
  async getModelCapabilities(model) {
    const key = "m:" + (model || "");
    if (this._capsCache && this._capsCache._key === key) return this._capsCache;
    try {
      const r = await this._rpcRaw("get_capabilities", { model: model || this.model || "" }, 15000);
      if (!r.ok) return null;
      const caps = { ...(r.capabilities || {}), name: "seedance", displayName: "火山方舟 Seedance", model: model || this.model || "", family: r.family, _key: key, async: true, concurrencyLimit: 1 };
      this._capsCache = caps;
      return caps;
    } catch {
      return null;
    }
  }

  /** 能力校验（worker 正式 RPC）：阻断错误绝不创建远程任务。ok:false 原样返回结构化 errors。 */
  async validateGenerationRequest(spec) {
    const r = await this._rpcRaw("validate_generation_request", { spec }, 15000);
    return {
      ok: Boolean(r.ok),
      errors: Array.isArray(r.errors) ? r.errors : [],
      warnings: Array.isArray(r.warnings) ? r.warnings : [],
      capabilities: r.capabilities || null,
    };
  }

  /** 统一 validateRequest 接口（异步）：校验失败返回 errors，阻断任务创建。 */
  async validateRequest(req) {
    if (!req.model) {
      return { ok: false, errors: [{ param: "model", message: "未配置模型 ID（请在设置页配置 Seedance 模型）", fix: "配置 SEEDANCE_MODEL" }], warnings: [] };
    }
    return this.validateGenerationRequest(req.spec || { model: req.model, resolution: req.resolution, ratio: req.ratio, duration: req.duration, generate_audio: req.generate_audio, watermark: req.watermark, return_last_frame: req.return_last_frame, references: req.references || {} });
  }

  /* ---- Provider 生命周期（异步） ---- */
  /** 提交生成任务，返回 { ok, providerJobId }（不等待完成）。 */
  async submitGeneration(req) {
    const spec = req.spec || {};
    const r = await this._rpc("create_task", { spec });
    return { ok: true, providerJobId: r.task_id, raw: r.raw || {}, base_url: r.base_url, billing_mode: r.billing_mode };
  }

  async pollGeneration(jobId, spec = {}) {
    const r = await this._rpc("get_task", { spec, task_id: jobId });
    return { status: r.status, raw: r.raw || {} };
  }

  async cancelGeneration(jobId, spec = {}) {
    const r = await this._rpc("cancel_or_delete_task", { spec, task_id: jobId });
    return { ok: r.ok === true, ...r };
  }

  /** 下载结果到项目资产目录；返回本地文件元数据（含哈希）。 */
  async downloadResult(jobId, targetPath, spec = {}) {
    const r = await this._rpc("download_result", { spec, task_id: jobId, target_path: targetPath });
    if (!r.ok) {
      const err = new Error(r.error || "下载失败");
      err.kind = r.error_kind || "download";
      throw err;
    }
    return {
      path: r.path, bytes: r.bytes, sha256: r.sha256,
      contentType: r.content_type, contentLength: r.content_length,
    };
  }

  /** 上传本地素材到 TOS（预签名 URL / 临时凭证），供 AssetUploader 使用。 */
  async tosUpload(localPath, meta = {}) {
    const r = await this._rpc("tos_upload", { local_path: localPath, mime: meta.mime || "" }, 600000);
    return r;
  }

  /** 凭证注入状态诊断（只返回布尔值，绝不返回 Key 本体）。 */
  async envStatus() {
    const r = await this._rpc("env_status", {}, 10000);
    return r;
  }

  normalizeError(e) {
    return { code: "seedance_error", message: String(e?.message ?? e), kind: e?.kind || "unknown" };
  }

  retry(req) { return this.submitGeneration(req); }

  dispose() {
    this._disposed = true;
    if (this._proc) { try { this._proc.kill(); } catch { /* ignore */ } this._proc = null; }
  }
}

export default SeedanceWorkerProvider;
