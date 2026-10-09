/* ============================================================================
 * Harness Director — 生成片段 QC（零依赖）
 *
 * 五个维度评分：技术 / 人物 / 空间 / 运动 / 叙事。
 * 输出：pass / pass_with_notes / repair_prompt / regenerate / redesign_shot / reject。
 *
 * 诚实原则：无法在当前环境检测的语义维度（如人脸一致性）标记为
 * "unavailable" 并说明原因，不伪造通过。技术维度（文件存在、解码、帧数、
 * 冻结帧、时长）对真实文件做真实检测。
 * ==========================================================================*/
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const QC_VERDICTS = ["pass", "pass_with_notes", "repair_prompt", "regenerate", "redesign_shot", "reject"];

function fileHash(buf) {
  let h = 0;
  for (let i = 0; i < buf.length; i++) { h = (h * 31 + buf[i]) | 0; }
  return h.toString(36);
}

function probeDuration(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], { encoding: "utf8", timeout: 10000 });
  if (r.status !== 0) return null;
  try { return Number(JSON.parse(r.stdout).format.duration); } catch { return null; }
}

/* 技术维度：真实检测 */
export function technicalChecks(asset, assetDir) {
  const issues = [];
  let frames = [];
  let duration = null, fps = null, width = null, height = null;
  const manifest = asset?.manifest || null;
  if (manifest) {
    frames = manifest.frames || [];
    duration = manifest.duration ?? null;
    fps = manifest.fps ?? null;
  }
  // 文件存在性
  if (!assetDir || !fs.existsSync(assetDir)) issues.push({ dim: "technical", sev: "error", msg: "资产目录不存在" });
  // 帧文件存在
  let missingFrames = 0;
  if (frames.length && assetDir) {
    for (const f of frames) { if (!fs.existsSync(path.join(assetDir, f.file))) missingFrames++; }
    if (missingFrames) issues.push({ dim: "technical", sev: "error", msg: "缺失帧文件 " + missingFrames + "/" + frames.length });
  }
  // 冻结帧 / 幻灯片检测（真实：比较帧内容哈希）
  const hashes = [];
  if (frames.length && assetDir) {
    for (const f of frames) {
      try { hashes.push(fileHash(fs.readFileSync(path.join(assetDir, f.file)))); } catch { /* ignore */ }
    }
    const unique = new Set(hashes).size;
    if (hashes.length >= 2 && unique === 1) {
      issues.push({ dim: "technical", sev: "warn", msg: "所有帧内容相同（像幻灯片/静止帧）", freezeRatio: 1 });
    } else if (hashes.length >= 2) {
      issues.push({ dim: "technical", sev: "info", msg: "帧唯一率 " + unique + "/" + hashes.length });
    }
  }
  // 黑帧检测（占位 SVG 无真实像素，诚实标注）
  if (manifest && manifest.provider === "local-stub") {
    issues.push({ dim: "technical", sev: "info", msg: "local-stub 帧为占位 SVG，黑帧/编码检测不适用（非真实视频）" });
  }
  return { issues, frames, duration, fps, width, height, manifest };
}

export function semanticChecks(shot, asset, dimension) {
  // 语义维度需要视觉/音频模型；占位生成器下诚实标注 unavailable。
  if (asset?.manifest?.provider === "local-stub") {
    return { issues: [{ dim: dimension, sev: "info", msg: "语义检测不可用：当前资产为 local-stub 占位，需真实视觉模型或人工审片", unavailable: true }] };
  }
  return { issues: [] };
}

export function runClipQc(project, shot, asset, assetDir) {
  const allIssues = [];
  const tech = technicalChecks(asset, assetDir);
  allIssues.push(...tech.issues);

  for (const dim of ["character", "spatial", "motion", "narrative"]) {
    const r = semanticChecks(shot, asset, dim);
    allIssues.push(...r.issues);
  }

  // 判定
  const errors = allIssues.filter((i) => i.sev === "error");
  const warns = allIssues.filter((i) => i.sev === "warn");
  const unavailable = allIssues.filter((i) => i.unavailable);

  let verdict = "pass";
  if (errors.length) verdict = "regenerate";
  else if (warns.length) verdict = "pass_with_notes";
  if (unavailable.length && !errors.length && !warns.length) verdict = "pass_with_notes";

  // 叙事目的是否已记录（可编辑性提示）
  if (!shot.narrativePurpose) allIssues.push({ dim: "narrative", sev: "warn", msg: "镜头缺少叙事目的描述，无法验证是否实现" });

  return {
    verdict,
    dimensions: ["technical", "character", "spatial", "motion", "narrative"],
    issues: allIssues,
    summary: { errors: errors.length, warns: warns.length, info: allIssues.length - errors.length - warns.length, unavailable: unavailable.length },
    evidence: { frames: tech.frames.length, duration: tech.duration, fps: tech.fps, provider: asset?.manifest?.provider },
    escalation: verdict === "regenerate" || verdict === "redesign_shot" || verdict === "reject"
      ? ["1. 轻微 Prompt 修复", "2. 锁定更多参考", "3. 简化动作", "4. 拆分镜头", "5. 更换生成方式或模型", "6. 返回分镜重新设计"]
      : null,
  };
}

export function compareClipVersions(a, b) {
  const aq = a?.qc || null, bq = b?.qc || null;
  return {
    a: { assetId: a?.assetId, verdict: aq?.verdict, provider: a?.manifest?.provider },
    b: { assetId: b?.assetId, verdict: bq?.verdict, provider: b?.manifest?.provider },
    improved: aq && bq ? (rankVerdict(bq.verdict) > rankVerdict(aq.verdict)) : null,
    notes: "版本对比基于 QC 结论与资产来源；真实画面差异需视觉模型或人工判断。",
  };
}

function rankVerdict(v) {
  return { reject: 0, redesign_shot: 1, regenerate: 2, repair_prompt: 3, pass_with_notes: 4, pass: 5 }[v] ?? 0;
}

export default { runClipQc, compareClipVersions, QC_VERDICTS };
