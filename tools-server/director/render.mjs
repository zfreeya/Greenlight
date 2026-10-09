/* ============================================================================
 * Harness Director — 渲染编译（零依赖）
 *
 * 把非破坏性时间线编译为 FFmpeg 命令（concat + filter_complex），
 * 输出可复现的 shell 脚本；ffmpeg 存在时直接执行生成 MP4。
 *
 * 时间线逻辑为结构化数据，不依赖聊天记录；渲染后端可替换为 Remotion 等。
 * ==========================================================================*/
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { totalDuration } from "./timeline.mjs";

export function ffmpegAvailable() {
  return fs.existsSync("/usr/local/bin/ffmpeg") || fs.existsSync("/opt/homebrew/bin/ffmpeg") || fs.existsSync("/usr/bin/ffmpeg");
}

function shellArg(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

/* 解析一个 clip 的输入来源：帧序列目录优先，其次单文件。 */
function resolveInput(clip, assetResolver) {
  const src = assetResolver(clip.assetId || clip.versionRef);
  if (!src) return null;
  if (typeof src === "object") {
    if (src.frameDir) return { kind: "frames", value: src.frameDir };
    if (src.file) return { kind: "file", value: src.file };
    return null;
  }
  return { kind: "file", value: src };
}

/* 编译时间线 → FFmpeg 命令 + shell 脚本 */
export function compileRender(timeline, project, opts = {}) {
  const fps = timeline.global?.fps || project.fps || 24;
  const width = timeline.global?.width || 1920;
  const height = timeline.global?.height || 1080;
  const outFile = opts.outFile || "final.mp4";
  const preview = Boolean(opts.preview);
  const assetResolver = opts.assetResolver || ((id) => opts.assets?.[id] || null);

  // 收集所有 clip 并按输入去重编号
  const clips = [];
  for (const track of timeline.videoTracks) for (const clip of track.clips) clips.push(clip);

  const inputIndex = new Map();
  const inputs = [];
  for (const clip of clips) {
    const inp = resolveInput(clip, assetResolver);
    if (!inp) continue;
    const key = inp.kind + ":" + inp.value;
    if (!inputIndex.has(key)) {
      inputIndex.set(key, inputs.length);
      inputs.push(inp);
    }
  }

  const inputArgs = [];
  for (const inp of inputs) {
    if (inp.kind === "frames") {
      inputArgs.push("-framerate", String(fps), "-pattern_type", "glob", "-i", shellArg(path.join(inp.value, "*.svg")));
    } else {
      inputArgs.push("-i", shellArg(inp.value));
    }
  }

  // 每个 clip 一个 filter 段输出 [vsegN]
  const segFilters = [];
  let n = 0;
  for (const clip of clips) {
    const inp = resolveInput(clip, assetResolver);
    if (!inp) continue;
    const key = inp.kind + ":" + inp.value;
    const inIdx = inputIndex.get(key);
    const dur = clip.duration || 5;
    const speed = clip.speed || 1;
    const chain = [
      "[" + inIdx + ":v]trim=duration=" + dur + ",setpts=PTS-STARTPTS",
      speed !== 1 ? "setpts=PTS/" + speed : null,
      "scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease,pad=" + width + ":" + height + ":(ow-iw)/2:(oh-ih)/2,setsar=1",
      clip.fadeIn ? "fade=t=in:st=0:d=" + clip.fadeIn : null,
      clip.fadeOut ? "fade=t=out:st=" + Math.max(0, dur - clip.fadeOut) + ":d=" + clip.fadeOut : null,
    ].filter(Boolean);
    segFilters.push(chain.join(",") + "[vseg" + n + "]");
    n++;
  }

  const concatIn = segFilters.map((_, i) => "[vseg" + i + "]").join("");
  const filterComplex = segFilters.join(";") + (segFilters.length ? ";" : "") + concatIn + "concat=n=" + segFilters.length + ":v=1:a=0[outv]";

  const parts = [
    "ffmpeg -y",
    ...inputArgs,
    "-filter_complex", shellArg(filterComplex),
    "-map", "[outv]",
    "-r", String(fps),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    preview ? "-vf scale=960:-2 -preset veryfast" : "-preset medium",
    shellArg(outFile),
  ].filter(Boolean);

  const command = parts.join(" ");
  const script = "#!/usr/bin/env bash\nset -euo pipefail\ncd " + shellArg(opts.workdir || ".") + "\n" + command + "\n";
  return {
    command,
    script,
    clipCount: segFilters.length,
    totalDuration: totalDuration(timeline),
    preview,
    outFile,
    inputCount: inputs.length,
  };
}

/* 执行渲染（ffmpeg 存在时真实执行；否则返回命令供复现） */
export function renderTimeline(timeline, project, opts = {}) {
  const compiled = compileRender(timeline, project, opts);
  if (!ffmpegAvailable()) {
    return { ok: true, executed: false, reason: "ffmpeg 未安装", ...compiled, note: "已生成可复现 FFmpeg 命令与脚本，安装 ffmpeg 后执行即可产出 MP4。" };
  }
  const outDir = path.dirname(compiled.outFile);
  fs.mkdirSync(outDir, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", compiled.command], { cwd: opts.workdir || process.cwd() });
    let err = "";
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", (code) => {
      resolve({ ok: code === 0, executed: true, exitCode: code, outFile: compiled.outFile, stderrTail: err.slice(-500), ...compiled });
    });
  });
}

export default { compileRender, renderTimeline, ffmpegAvailable };
