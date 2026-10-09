/* ============================================================================
 * FFmpeg 本地真实导出测试（testsrc/sine 本地素材，不访问网络、不调用 Provider、零费用）
 *
 * 前置：本机已安装 ffmpeg/ffprobe（brew install ffmpeg）。未安装时整组 skip。
 * 验证：MP4 存在、ffprobe 可读、H.264/AAC/yuv420p/faststart、时长/分辨率正确、
 *       原子输出（无临时文件残留）、失败不覆盖旧成片。
 * 运行：node --test tools-server/director/ffmpeg-real.test.mjs
 * ==========================================================================*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as FF from "./ffmpeg.mjs";
import { newProject } from "./types.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const det = FF.detectFfmpeg();
const HAVE_FFMPEG = det.available;

/** 用 FFmpeg 内置源生成素材（color/testsrc + sine），零网络零费用。 */
function makeSource(dir, name, opts = {}) {
  const out = path.join(dir, name + ".mp4");
  const args = ["-y", "-f", "lavfi", "-i", "color=c=" + (opts.color || "0x223344") + ":s=320x180:d=3",
    "-f", "lavfi", "-i", "sine=frequency=" + (opts.freq || 440) + ":duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out];
  const r = spawnSync(det.ffmpeg, args, { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) throw new Error("生成测试素材失败：" + (r.stderr || "").slice(-300));
  return out;
}

function probeFile(file) {
  const r = spawnSync(det.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error("ffprobe 失败：" + (r.stderr || "").slice(-200));
  return JSON.parse(r.stdout);
}

test("FFmpeg 真实导出：testsrc/sine → MP4 → ffprobe 校验（H.264/AAC/yuv420p/faststart/时长/分辨率）", async (t) => {
  if (!HAVE_FFMPEG) return t.skip("ffmpeg 未安装：先执行 brew install ffmpeg");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ffreal-"));
  try {
    // 2~3 个不同颜色片段 + 音频
    const a = makeSource(dir, "clip-a", { color: "0x223344", freq: 440 });
    const b = makeSource(dir, "clip-b", { color: "0x883322", freq: 523 });
    const c = makeSource(dir, "clip-c", { color: "0x228833", freq: 659 });

    const timeline = {
      videoTracks: [{
        id: "V1",
        clips: [
          { clipId: "c1", assetId: "AST-A", versionRef: "AST-A", start: 0, end: 3, duration: 3, volume: 1, fadeIn: 0.2 },
          { clipId: "c2", assetId: "AST-B", versionRef: "AST-B", start: 3, end: 6, duration: 3, volume: 0.8 },
          { clipId: "c3", assetId: "AST-C", versionRef: "AST-C", start: 6, end: 9, duration: 3, volume: 0.5, fadeOut: 0.3 },
        ],
      }],
      audioTracks: [{ id: "A1", clips: [] }],
      captions: [], markers: [], transitions: [],
      global: { width: 320, height: 180, fps: 24, audioEnabled: true },
    };
    const project = newProject({ projectId: "D-FF", title: "ffreal", fps: 24 });
    const assets = { "AST-A": { file: a }, "AST-B": { file: b }, "AST-C": { file: c } };
    const outFile = path.join(dir, "final.mp4");

    const r = await FF.exportTimeline(timeline, project, {
      outFile, baseDir: dir, fps: 24, crf: 23, assetResolver: (id) => assets[id],
    });
    assert.equal(r.executed, true, "应真实执行 ffmpeg");
    assert.equal(r.ok, true, "ffmpeg 应成功（stderr=" + (r.stderrTail || "").slice(-200) + ")");
    assert.ok(fs.existsSync(outFile), "MP4 应存在");

    // 原子输出：不应残留临时文件
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp-"));
    assert.equal(leftovers.length, 0, "不得残留临时文件");

    const info = probeFile(outFile);
    const v = (info.streams || []).find((s) => s.codec_type === "video");
    const aud = (info.streams || []).find((s) => s.codec_type === "audio");
    if (!v) console.log("[ffmpeg-real] probe streams=" + JSON.stringify((info.streams || [])) + " format=" + JSON.stringify(info.format) + " size=" + fs.statSync(outFile).size);
    assert.equal(v.codec_name, "h264", "视频编码应为 H.264");
    assert.equal(v.pix_fmt, "yuv420p", "像素格式应为 yuv420p");
    assert.equal(aud.codec_name, "aac", "音频编码应为 AAC");
    assert.equal(aud.sample_rate, "48000", "音频采样率应为 48kHz");
    assert.ok(Math.abs(Number(info.format.duration) - 9) <= 0.5, "总时长应约 9s，实际 " + info.format.duration);
    assert.equal(v.width, 320);
    assert.equal(v.height, 180);
    // faststart（moov 前置）
    const head = fs.readFileSync(outFile).subarray(0, 1024 * 1024);
    const moovIdx = head.indexOf(Buffer.from("moov"));
    assert.ok(moovIdx >= 0, "faststart 要求 moov 在文件前部");
  } finally {
    // 清理
    try { for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)); fs.rmdirSync(dir); } catch { /* ignore */ }
  }
});

test("FFmpeg 原子输出：失败不覆盖旧成片", async (t) => {
  if (!HAVE_FFMPEG) return t.skip("ffmpeg 未安装");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ffatomic-"));
  try {
    const src = makeSource(dir, "good", { color: "0x112233" });
    const outFile = path.join(dir, "out.mp4");
    const project = newProject({ projectId: "D-FF2", fps: 24 });
    const timeline = { videoTracks: [{ id: "V1", clips: [{ clipId: "c1", assetId: "AST-A", start: 0, end: 3, duration: 3 }] }], audioTracks: [{ id: "A1", clips: [] }], captions: [], markers: [], transitions: [], global: { width: 320, height: 180, fps: 24 } };
    const ok1 = await FF.exportTimeline(timeline, project, { outFile, baseDir: dir, assetResolver: () => ({ file: src }) });
    assert.equal(ok1.ok, true);
    const before = fs.readFileSync(outFile);
    // 失败场景：输入文件不存在 → ffmpeg 报错，不应覆盖旧成片
    const bad = await FF.exportTimeline(timeline, project, { outFile, baseDir: dir, assetResolver: () => ({ file: path.join(dir, "missing.mp4") }) });
    assert.equal(bad.ok, false, "输入缺失时导出应失败");
    assert.deepEqual(fs.readFileSync(outFile), before, "失败不得覆盖旧成片");
  } finally {
    try { for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)); fs.rmdirSync(dir); } catch { /* ignore */ }
  }
});
