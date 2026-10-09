/* ============================================================================
 * FFmpeg 后期系统测试：参数数组（无 shell 注入）、检测、安装计划、探测诚实。
 * 运行：node --test tools-server/director/ffmpeg.test.mjs
 * ==========================================================================*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as FF from "./ffmpeg.mjs";
import { newProject } from "./types.mjs";

test("detect: 返回结构化检测结果", () => {
  const d = FF.detectFfmpeg();
  assert.ok("available" in d);
  assert.ok("ffmpeg" in d);
  assert.ok("ffprobe" in d);
});

test("install-plan: 三档镜像 + 不默认改 shell 配置", () => {
  const plan = FF.ffmpegInstallPlan();
  assert.ok(Array.isArray(plan.plan));
  assert.equal(plan.plan.length, 3);
  assert.equal(plan.plan[0].mirror, "清华");
  assert.equal(plan.plan[1].mirror, "中科大");
  assert.equal(plan.plan[2].mirror, "官方");
  assert.ok(/不默认写入/.test(plan.note), "应明确不默认改 shell 配置");
});

test("probe: ffmpeg 未安装时诚实返回", async () => {
  const r = FF.probe("/tmp/nonexistent.mp4");
  if (r.available === false) {
    assert.ok(r.reason, "未安装时应给出原因");
  } else {
    assert.ok("ok" in r, "已安装时返回探测结果");
  }
});

test("security: FFmpeg 参数数组不受文件名注入", async () => {
  const evil = "evil;rm -rf $HOME /$(id).mp4";
  const timeline = {
    videoTracks: [{ id: "V1", clips: [{ clipId: "c1", assetId: "AST-evil", start: 0, end: 5, duration: 5 }] }],
    audioTracks: [], captions: [], markers: [], transitions: [],
    global: { width: 1920, height: 1080, fps: 24 },
  };
  const project = newProject({ projectId: "D-f" });
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ff-out-")), "final.mp4");
  const r = await FF.exportTimeline(timeline, project, {
    outFile, baseDir: path.dirname(outFile),
    assetResolver: (id) => ({ file: path.join("/tmp", evil) }),
  });
  // 无论 ffmpeg 是否安装，都返回 args 数组
  assert.ok(Array.isArray(r.args), "必须返回参数数组");
  // 恶意文件名必须作为单个 argv 元素出现，而非被 shell 拆解
  const joined = r.args.join("\n");
  assert.ok(r.args.some((a) => typeof a === "string" && a.includes(evil)), "恶意文件名应作为单元素传递");
  assert.ok(!joined.includes("\nrm\n"), "不得把 rm 拆成独立参数");
  // 生成的 command 仅用于展示，不应直接 exec 到 shell（这里只做展示字符串，执行走 spawn 数组）
});

test("security: 输出路径穿越被拒绝", () => {
  const base = path.join(os.tmpdir(), "ff-base");
  assert.throws(() => FF.assertInside(base, path.join(base, "..", "evil.mp4")), "路径穿越应被拒绝");
  assert.doesNotThrow(() => FF.assertInside(base, path.join(base, "sub", "ok.mp4")));
});
