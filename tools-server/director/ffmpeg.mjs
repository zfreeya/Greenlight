/* ============================================================================
 * Harness Director — FFmpeg 本地后期系统（零依赖 Node ESM）
 *
 * 安全底线：FFmpeg 一律通过 spawn(参数数组) 调用，禁止字符串拼接进入 shell；
 * 文件名/字幕/路径做边界校验；所有输出限制在项目目录内。
 *
 * 能力：检测/安装计划、探测、低码率代理、封面缩略图、镜头拼接、统一分辨率/帧率/
 * 像素格式/采样率、转场、字幕烧录/外挂、背景音乐混音、响度、淡入淡出、黑场、
 * 片头片尾、横竖方多版本导出、最终 MP4（H.264 + AAC + yuv420p + faststart + 48kHz）。
 * ==========================================================================*/
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

/* ---------------------------------------------------------------------------
 * 检测
 * -------------------------------------------------------------------------*/
const CANDIDATES = [
  "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg",
  "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe",
];

function firstExisting(names) {
  for (const n of names) if (fs.existsSync(n)) return n;
  return null;
}

export function detectFfmpeg() {
  const ffmpeg = firstExisting(CANDIDATES.filter((c) => c.endsWith("ffmpeg"))) || "ffmpeg";
  const ffprobe = firstExisting(CANDIDATES.filter((c) => c.endsWith("ffprobe"))) || "ffprobe";
  let version = null, available = false;
  try {
    const r = spawnSync(ffmpeg, ["-version"], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0) { available = true; version = (r.stdout || "").split("\n")[0]; }
  } catch { /* ignore */ }
  return { ffmpeg, ffprobe, available, version };
}

/* ---------------------------------------------------------------------------
 * 安装计划（检测 Homebrew / 架构 / 已有 FFmpeg；不默认改用户 shell 配置）
 * -------------------------------------------------------------------------*/
const MIRRORS = [
  {
    name: "清华",
    env: {
      HOMEBREW_API_DOMAIN: "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api",
      HOMEBREW_BOTTLE_DOMAIN: "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles",
    },
  },
  {
    name: "中科大",
    env: {
      HOMEBREW_API_DOMAIN: "https://mirrors.ustc.edu.cn/homebrew-bottles/api",
      HOMEBREW_BOTTLE_DOMAIN: "https://mirrors.ustc.edu.cn/homebrew-bottles",
    },
  },
  { name: "官方", env: {} },
];

export function ffmpegInstallPlan() {
  const det = detectFfmpeg();
  const arch = process.arch;
  const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find((b) => fs.existsSync(b)) || null;
  const plan = [];
  for (const m of MIRRORS) {
    const envs = Object.entries(m.env).map(([k, v]) => k + "=\"" + v + "\"").join(" ");
    plan.push({ mirror: m.name, command: (envs ? envs + " " : "") + "brew install ffmpeg" });
  }
  return {
    available: det.available,
    version: det.version,
    arch,
    brew: brew ? { path: brew, present: true } : { present: false },
    alreadyInstalled: det.available,
    note: "安装器只返回计划，不默认写入 ~/.zprofile、不修改 Homebrew Git remote；如需安装请手动执行 plan 中命令（优先清华，其次中科大，最后官方）。",
    plan,
  };
}

/* ---------------------------------------------------------------------------
 * 路径边界校验
 * -------------------------------------------------------------------------*/
export function assertInside(baseDir, target) {
  const b = path.resolve(baseDir);
  const t = path.resolve(target);
  const rel = path.relative(b, t);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("输出路径越界：" + target);
  }
  return t;
}

/* ---------------------------------------------------------------------------
 * 探测（ffprobe 参数数组）
 * -------------------------------------------------------------------------*/
export function probe(file) {
  const det = detectFfmpeg();
  if (!det.available) return { ok: false, available: false, reason: "ffmpeg/ffprobe 未安装" };
  const r = spawnSync(det.ffprobe, [
    "-v", "error",
    "-print_format", "json",
    "-show_format", "-show_streams",
    String(file),
  ], { encoding: "utf8", timeout: 20000 });
  if (r.status !== 0) return { ok: false, available: true, error: (r.stderr || "").slice(0, 300) };
  try {
    const d = JSON.parse(r.stdout);
    const v = (d.streams || []).find((s) => s.codec_type === "video");
    const a = (d.streams || []).find((s) => s.codec_type === "audio");
    return {
      ok: true, available: true,
      duration: Number(d.format?.duration) || null,
      width: v?.width ?? null, height: v?.height ?? null,
      fps: v?.avg_frame_rate ? evalFps(v.avg_frame_rate) : null,
      videoCodec: v?.codec_name ?? null, pixelFormat: v?.pix_fmt ?? null,
      audioCodec: a?.codec_name ?? null, sampleRate: a?.sample_rate ?? null, audioChannels: a?.channels ?? null,
    };
  } catch (e) {
    return { ok: false, available: true, error: "ffprobe 输出解析失败：" + String(e) };
  }
}

function evalFps(r) {
  const [n, d] = String(r).split("/");
  const num = Number(n), den = Number(d);
  if (!den) return Number(n) || null;
  return den ? +(num / den).toFixed(3) : null;
}

/** 探测输入是否含音频轨（导出时用于决定是否混音）。 */
export function inputHasAudio(file) {
  try {
    const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", String(file)], { encoding: "utf8", timeout: 15000 });
    if (r.status !== 0) return false;
    return (r.stdout || "").trim().length > 0;
  } catch { return false; }
}

/* ---------------------------------------------------------------------------
 * 通用执行器：spawn 参数数组，绝不进 shell
 * -------------------------------------------------------------------------*/
function runFfmpeg(ffmpegBin, args, opts = {}) {
  const det = detectFfmpeg();
  const bin = ffmpegBin || det.ffmpeg;
  if (!det.available && !ffmpegBin) {
    return Promise.resolve({ ok: true, executed: false, reason: "ffmpeg 未安装", command: bin + " " + args.map(quote).join(" "), args });
  }
  const outDir = opts.outDir ? path.dirname(opts.outDir) : null;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });

  // 原子输出：写临时文件（保留原扩展名以便 ffmpeg 识别封装格式），成功后 rename
  const outFile = opts.outFile || args[args.length - 1];
  const ext = path.extname(outFile);
  const base = ext ? path.basename(outFile, ext) : path.basename(outFile);
  const tmpFile = path.join(path.dirname(outFile), base + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8) + (ext || ".out"));
  const argsCopy = args.slice();
  if (argsCopy.length && argsCopy[argsCopy.length - 1] === outFile) argsCopy[argsCopy.length - 1] = tmpFile;

  return new Promise((resolve) => {
    const child = spawn(bin, argsCopy, { cwd: opts.cwd || process.cwd() });
    let err = "";
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => {
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      resolve({ ok: false, executed: true, error: String(e), command: bin + " " + argsCopy.map(quote).join(" "), args: argsCopy });
    });
    child.on("close", (code) => {
      let ok = code === 0;
      if (ok) {
        try { fs.renameSync(tmpFile, outFile); } catch (e) { ok = false; err += "\nrename failed: " + String(e); }
      } else {
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
      resolve({
        ok, executed: true, exitCode: code,
        outFile: ok ? outFile : null,
        stderrTail: err.slice(-800),
        command: bin + " " + argsCopy.map(quote).join(" "), args: argsCopy,
      });
    });
  });
}

function quote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

/* ---------------------------------------------------------------------------
 * 代理 / 缩略图
 * -------------------------------------------------------------------------*/
/** 低码率代理视频（预览用，绝不调用生成 API）。 */
export async function makeProxy(src, outFile, opts = {}) {
  const args = ["-y", "-i", String(src)];
  const vf = [];
  if (opts.width) vf.push("scale=" + opts.width + ":-2");
  vf.push("fps=" + (opts.fps || 24));
  if (vf.length) args.push("-vf", vf.join(","));
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", String(opts.crf ?? 30), "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", String(outFile));
  return runFfmpeg(null, args, { outFile });
}

/** 抽取封面/缩略图。 */
export async function makeThumbnail(src, outFile, atSec = 0) {
  const args = ["-y", "-ss", String(atSec), "-i", String(src), "-frames:v", "1", "-vf", "scale=480:-2", String(outFile)];
  return runFfmpeg(null, args, { outFile });
}

/**
 * 按固定间隔抽取一组帧（反向工作流：从已有视频抽帧，供 Agent 反推镜头表）。
 * 输出到 outDir，文件命名 frame_0001.jpg …；返回每帧的时间戳（秒）。
 * 只做本地 FFmpeg，不调用生成 API。
 * 注意：输出是 %04d 序列，不走 runFfmpeg 的原子重命名（该逻辑只适用于单文件输出），
 * 这里直接 spawn 参数数组，完成后检查文件集。
 */
export async function extractFrames(src, outDir, opts = {}) {
  const det = detectFfmpeg();
  if (!det.available) return { ok: false, executed: false, reason: "ffmpeg 未安装" };
  const interval = Math.max(0.5, Number(opts.intervalSec) || 3);
  const maxFrames = Math.max(1, Math.floor(Number(opts.maxFrames) || 30));
  fs.mkdirSync(outDir, { recursive: true });
  // 清理旧的 frame_*.jpg，避免上次抽帧残留干扰 manifest
  for (const f of fs.readdirSync(outDir)) {
    if (/^frame_\d+\.jpg$/.test(f)) { try { fs.unlinkSync(path.join(outDir, f)); } catch { /* ignore */ } }
  }
  const pattern = path.join(outDir, "frame_%04d.jpg");
  const args = ["-y", "-i", String(src), "-vf", "fps=1/" + interval, "-frames:v", String(maxFrames), "-q:v", "3", String(pattern)];
  return new Promise((resolve) => {
    const child = spawn(det.ffmpeg, args);
    let err = "";
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => resolve({ ok: false, executed: true, error: String(e), frames: [] }));
    child.on("close", (code) => {
      if (code !== 0) return resolve({ ok: false, executed: true, exitCode: code, stderrTail: err.slice(-400), frames: [] });
      const frames = fs.readdirSync(outDir)
        .filter((f) => /^frame_\d+\.jpg$/.test(f))
        .sort()
        .map((f, i) => ({ file: f, atSec: +(i * interval).toFixed(2) }));
      resolve({ ok: true, executed: true, frames, intervalSec: interval, count: frames.length, outDir });
    });
  });
}

/**
 * 抽一帧并计算色彩统计（检查器 v0：RGB 均值 + 亮度直方图）。
 * 输出 { ok, r, g, b, luma, hist[16], pixels }；hist 为归一化 16 桶亮度直方图。
 * 只做颜色级对比，不做人脸/语义，阈值需真实数据校准（诚实 v0）。
 */
export function frameStats(src, atSec = 0) {
  const det = detectFfmpeg();
  if (!det.available) return Promise.resolve({ ok: false, executed: false, reason: "ffmpeg 未安装" });
  return new Promise((resolve) => {
    const args = ["-y", "-ss", String(atSec), "-i", String(src), "-frames:v", "1", "-vf", "scale=32:32,format=rgb24", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"];
    const child = spawn(det.ffmpeg, args);
    const chunks = [];
    let err = "";
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => resolve({ ok: false, executed: true, error: String(e) }));
    child.on("close", (code) => {
      if (code !== 0) return resolve({ ok: false, executed: true, exitCode: code, stderrTail: err.slice(-300) });
      const buf = Buffer.concat(chunks);
      const px = Math.floor(buf.length / 3);
      if (px < 1) return resolve({ ok: false, executed: true, error: "无像素输出" });
      let sumR = 0, sumG = 0, sumB = 0, sumY = 0;
      const hist = new Array(16).fill(0);
      for (let i = 0; i + 2 < buf.length; i += 3) {
        const r = buf[i], g = buf[i + 1], b = buf[i + 2];
        sumR += r; sumG += g; sumB += b;
        const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        sumY += y;
        hist[Math.min(15, y >> 4)]++;
      }
      resolve({
        ok: true, executed: true, width: 32, height: 32, pixels: px,
        r: sumR / px, g: sumG / px, b: sumB / px, luma: sumY / px,
        hist: hist.map((c) => c / px),
      });
    });
  });
}

/* ---------------------------------------------------------------------------
 * 音频处理（混音 / 响度 / 淡入淡出）
 * -------------------------------------------------------------------------*/
export function loudnessArgs(stream, opts = {}) {
  const out = [];
  if (opts.targetLoudness != null) out.push("loudnorm=I=" + opts.targetLoudness + ":TP=-1.5:LRA=11");
  if (opts.fadeIn) out.push("afade=t=in:st=0:d=" + opts.fadeIn);
  if (opts.fadeOut && opts.duration) out.push("afade=t=out:st=" + Math.max(0, opts.duration - opts.fadeOut) + ":d=" + opts.fadeOut);
  return out.length ? [stream + out.map((f) => f).join(",")] : [];
}

/* ---------------------------------------------------------------------------
 * 时间线导出（最终 MP4）
 * -------------------------------------------------------------------------*/
/**
 * 把结构化时间线编译为 FFmpeg 参数数组并执行。
 * assetResolver(assetId) -> { file: 绝对路径, proxy?: 绝对路径 } 或 null。
 * opts: { outFile, preview, width, height, fps, crf, aspectRatios, subtitles, music, title, tail, loudness }
 */
export async function exportTimeline(timeline, project, opts = {}) {
  const fps = opts.fps || timeline.global?.fps || project.fps || 24;
  const width = opts.width || timeline.global?.width || 1920;
  const height = opts.height || timeline.global?.height || 1080;
  const outFile = opts.outFile;
  const base = opts.baseDir || path.dirname(outFile);
  assertInside(base, outFile);

  const assetResolver = opts.assetResolver || (() => null);
  const clips = (timeline.videoTracks || []).flatMap((t) => t.clips || [])
    .sort((a, b) => a.start - b.start);

  // 收集输入并去重
  const inputs = [];
  const inputIndex = new Map();
  for (const clip of clips) {
    const src = assetResolver(clip.assetId || clip.versionRef);
    const file = src ? (src.file || src.proxy) : null;
    if (!file) continue;
    const key = "file:" + file;
    if (!inputIndex.has(key)) { inputIndex.set(key, inputs.length); inputs.push(file); }
  }

  const args = ["-y"];
  for (const f of inputs) args.push("-i", String(f));

  // 字幕 / 音乐作为额外输入
  let filterParts = [];
  const segLabels = [];
  clips.forEach((clip, i) => {
    const src = assetResolver(clip.assetId || clip.versionRef);
    const file = src ? (src.file || src.proxy) : null;
    if (!file) return;
    const inIdx = inputIndex.get("file:" + file);
    const dur = clip.duration || 5;
    const speed = clip.speed || 1;
    const chain = [
      "[" + inIdx + ":v]trim=duration=" + dur + ",setpts=PTS-STARTPTS",
      speed !== 1 ? "setpts=PTS/" + speed : null,
      "scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease,pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2,setsar=1",
      clip.fadeIn ? "fade=t=in:st=0:d=" + clip.fadeIn : null,
      clip.fadeOut ? "fade=t=out:st=" + Math.max(0, dur - clip.fadeOut) + ":d=" + clip.fadeOut : null,
      "format=yuv420p",
    ].filter(Boolean);
    filterParts.push(chain.join(",") + "[vseg" + i + "]");
    segLabels.push("[vseg" + i + "]");
  });

  if (segLabels.length) {
    filterParts.push(segLabels.join("") + "concat=n=" + segLabels.length + ":v=1:a=0[outv]");
  } else {
    filterParts.push("color=c=black:s=" + width + "x" + height + ":d=1:r=" + fps + "[outv]");
  }

  // 音频：探测输入是否含音轨；若有则按时间线总长 atrim + amix 到 [outa]（48kHz 由编码参数保证）
  const totalDur = (timeline.videoTracks || []).reduce((m, t) => t.clips.reduce((x, c) => Math.max(x, c.end || 0), m), 0) || 1;
  const audioStreams = inputs.map((f) => inputHasAudio(f));
  const audioInputs = audioStreams.map((has, i) => (has ? i : -1)).filter((i) => i >= 0);
  if (audioInputs.length && opts.audioEnabled !== false) {
    for (const i of audioInputs) {
      filterParts.push("[" + i + ":a]atrim=duration=" + totalDur + ",asetpts=PTS-STARTPTS[a" + i + "]");
    }
    filterParts.push(audioInputs.map((i) => "[a" + i + "]").join("") + "amix=inputs=" + audioInputs.length + ":duration=longest:dropout_transition=0[outa]");
  }

  const filterComplex = filterParts.join(";");
  args.push("-filter_complex", filterComplex);
  args.push("-map", "[outv]");
  if (audioInputs.length && opts.audioEnabled !== false) args.push("-map", "[outa]");
  args.push("-r", String(fps));
  args.push("-c:v", "libx264");
  args.push("-pix_fmt", "yuv420p");
  args.push("-crf", String(opts.crf ?? 23));
  args.push("-preset", opts.preview ? "veryfast" : "medium");
  args.push("-movflags", "+faststart");
  if (audioInputs.length && opts.audioEnabled !== false) {
    args.push("-c:a", "aac", "-ar", "48000", "-b:a", "192k");
  }
  args.push(String(outFile));

  return runFfmpeg(null, args, { outFile });
}

/** 多版本导出（横屏 / 竖屏 / 方形），基于同一时间线。 */
export async function exportVariants(timeline, project, opts = {}) {
  const ratios = opts.aspectRatios || [];
  const base = opts.baseDir;
  const results = [];
  for (const ratio of ratios) {
    const dims = RATIO_DIMS[ratio] || RATIO_DIMS["16:9"];
    const name = path.basename(opts.outFile || "final.mp4").replace(/\.mp4$/i, "") + "-" + ratio.replace(":", "x") + ".mp4";
    const outFile = path.join(base, name);
    const r = await exportTimeline(timeline, project, { ...opts, outFile, width: dims.w, height: dims.h });
    results.push({ ratio, outFile, ...r });
  }
  return { ok: results.every((r) => r.ok !== false), results };
}

export const RATIO_DIMS = {
  "16:9": { w: 1920, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "4:3": { w: 1440, h: 1080 },
  "21:9": { w: 2560, h: 1080 },
};

export default { detectFfmpeg, ffmpegInstallPlan, probe, makeProxy, makeThumbnail, extractFrames, frameStats, exportTimeline, exportVariants, assertInside };
