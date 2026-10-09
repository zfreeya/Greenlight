/* ============================================================================
 * Harness Director — VideoProviderAdapter（零依赖）
 *
 * 统一 Provider 接口：
 *   getCapabilities / getModels / estimateCost / validateRequest /
 *   submitGeneration / pollGeneration / cancelGeneration / downloadResult /
 *   normalizeError / retry / dispose
 *
 * 实现：
 *   - local-stub：本地确定性占位生成器（真实写文件，诚实标注非 AI 生成）
 * 火山方舟（Seedance）不在此注册表：一律走 seedance 生成引擎（Python sidecar + 官方 SDK），
 * 不依赖任何 CLI（arkcli 已废弃移除）。
 *
 * 不要把某一平台的参数写进通用 Shot 数据；由 PromptCompiler 按 Provider
 * 能力编译（见 prompt-compiler.mjs）。
 * ==========================================================================*/
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function providerCapabilities(providerName) {
  const p = PROVIDERS[providerName];
  return p ? p.getCapabilities() : null;
}

export function listProviders() {
  return Object.keys(PROVIDERS).map((name) => ({ name, ...PROVIDERS[name].getCapabilities() }));
}

/* ---------------------------------------------------------------------------
 * 通用工具：确定性 SVG 帧（local-stub 用它产出真实图片/关键帧）
 * -------------------------------------------------------------------------*/
function svgFrame(shot, opts = {}) {
  const palette = opts.palette || ["#f4efe7", "#b7a99a", "#4a4a55"];
  const idx = (shot.index ?? 0) % palette.length;
  const bg = opts.bg || palette[idx];
  const fg = opts.fg || "#2a2a33";
  const w = opts.w || 1920, h = opts.h || 1080;
  const safe = (s) => String(s || "").replace(/[<>&"]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${bg}"/>
  <rect x="${w * 0.08}" y="${h * 0.12}" width="${w * 0.84}" height="${h * 0.76}" fill="none" stroke="${fg}" stroke-width="${Math.max(2, w * 0.0015)}" rx="${w * 0.01}"/>
  <text x="${w * 0.5}" y="${h * 0.42}" font-family="sans-serif" font-size="${w * 0.035}" fill="${fg}" text-anchor="middle">${safe(shot.shotId)}</text>
  <text x="${w * 0.5}" y="${h * 0.52}" font-family="sans-serif" font-size="${w * 0.03}" fill="${fg}" text-anchor="middle">${safe(shot.subject || "subject")}</text>
  <text x="${w * 0.5}" y="${h * 0.6}" font-family="sans-serif" font-size="${w * 0.022}" fill="${fg}" text-anchor="middle">${safe(shot.shotSize || "")} · ${safe(shot.cameraMovement || "static")} · ${shot.duration ?? 0}s</text>
  <text x="${w * 0.5}" y="${h * 0.9}" font-family="sans-serif" font-size="${w * 0.015}" fill="${fg}" text-anchor="middle">local-stub keyframe (not AI-generated)</text>
</svg>`;
}

/* ---------------------------------------------------------------------------
 * local-stub：诚实标注的非 AI 生成器
 * -------------------------------------------------------------------------*/
class LocalStubProvider {
  constructor() { this.jobs = new Map(); }

  getCapabilities() {
    return {
      name: "local-stub",
      displayName: "本地占位生成器（非 AI）",
      textToVideo: true,
      imageToVideo: true,
      firstLastFrame: true,
      characterRef: true,
      videoRef: false,
      mask: false,
      maxDuration: 10,
      aspectRatios: ["16:9", "9:16", "1:1"],
      resolution: "1920x1080",
      supportsAudio: false,
      cameraControl: ["static", "pan", "zoom"],
      supportsSeed: true,
      negativePrompt: false,
      contentRestrictions: ["无内容安全审核（本地占位）"],
      concurrencyLimit: 2,
      pricing: { unit: "免费（本地占位）", perClip: 0 },
      timeoutMs: 30000,
      modelVersions: ["stub-1"],
      honest: "本 Provider 不调用任何 AI 模型，仅生成确定性占位帧，用于验证完整闭环；接入真实 Provider 后替换。",
    };
  }

  getModels() { return [{ id: "stub-1", version: "stub-1", modes: ["t2v", "i2v", "first-last"] }]; }

  estimateCost(req) { return { currency: "CNY", amount: 0, range: "0", note: "local-stub 免费占位" }; }

  validateRequest(req) {
    const caps = this.getCapabilities();
    const warnings = [];
    if (req.duration && req.duration > caps.maxDuration) warnings.push("时长超过 stub 上限 " + caps.maxDuration + "s，已截断");
    if (!req.shotId) warnings.push("缺少 shotId");
    return { ok: true, warnings };
  }

  submitGeneration(req, assetsDir) {
    const jobId = "stub-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    fs.mkdirSync(assetsDir, { recursive: true });
    const assetDir = path.join(assetsDir, jobId);
    fs.mkdirSync(assetDir, { recursive: true });
    const duration = Math.min(Number(req.duration) || 5, this.getCapabilities().maxDuration);
    const fps = Number(req.fps) || 2; // 占位：低帧率帧序列
    const frameCount = Math.max(2, Math.round(duration * fps));
    const frames = [];
    for (let i = 0; i < frameCount; i++) {
      const name = "frame-" + String(i).padStart(4, "0") + ".svg";
      fs.writeFileSync(path.join(assetDir, name), svgFrame(req.shot || {}, { palette: req.palette }));
      frames.push({ file: name, t: i / fps });
    }
    // 首帧/尾帧关键帧（图生视频语义）
    fs.writeFileSync(path.join(assetDir, "first.svg"), svgFrame(req.shot || {}, { palette: req.palette }));
    fs.writeFileSync(path.join(assetDir, "last.svg"), svgFrame(req.shot || {}, { palette: req.palette }));
    // 若 ffmpeg 可用，把占位帧渲染成真实可播放 MP4（H.264/AAC/yuv420p），
    // 使「本地生成 → 时间线 → FFmpeg 导出」全链路真实闭环；无 ffmpeg 时仅保留帧序列。
    let videoFile = null;
    try {
      const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].find((f) => fs.existsSync(f));
      if (ffmpeg) {
        videoFile = "stub.mp4";
        const color = (req.palette && req.palette[0]) || "#223344";
        const r = spawnSync(ffmpeg, [
          "-y",
          "-f", "lavfi", "-i", "color=c=" + color.replace("#", "0x") + ":s=320x180:d=" + duration,
          "-f", "lavfi", "-i", "sine=frequency=440:duration=" + duration,
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000",
          "-movflags", "+faststart", "-shortest",
          path.join(assetDir, videoFile),
        ], { encoding: "utf8", timeout: 60000 });
        if (r.status !== 0) videoFile = null;
      }
    } catch { videoFile = null; }
    const manifest = {
      provider: "local-stub", jobId, shotId: req.shotId, honest: "stub frames (not AI-generated)",
      duration, fps, frameCount, frames, seed: req.seed ?? null,
      prompt: req.prompt ?? "", generatedAt: Date.now(),
      videoFile,
    };
    fs.writeFileSync(path.join(assetDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    this.jobs.set(jobId, { status: "succeeded", manifest, assetDir });
    return { ok: true, providerJobId: jobId, status: "succeeded", manifest, assetDir };
  }

  pollGeneration(jobId) {
    const j = this.jobs.get(jobId);
    return j ? { status: j.status, progress: 1, manifest: j.manifest } : { status: "failed", error: "未知任务" };
  }

  cancelGeneration(jobId) { this.jobs.set(jobId, { status: "cancelled" }); return { ok: true }; }
  downloadResult(jobId) { const j = this.jobs.get(jobId); return j || null; }
  normalizeError(e) { return { code: "local_stub_error", message: String(e?.message ?? e) }; }
  retry(req, assetsDir) { return this.submitGeneration(req, assetsDir); }
  dispose() { this.jobs.clear(); }
}

export const PROVIDERS = {
  "local-stub": new LocalStubProvider(),
};

/**
 * 严格解析 Provider：local-stub 只能被显式选择；未知 Provider 抛错（失败关闭），
 * 绝不静默回退到 local-stub（防止「配置拼错却生成出占位结果」的假成功）。
 */
export function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) {
    throw new Error("未知 Provider：" + name + "（可用：" + Object.keys(PROVIDERS).join(", ") + "；火山方舟请走 seedance 生成引擎，不依赖 CLI）");
  }
  return p;
}
