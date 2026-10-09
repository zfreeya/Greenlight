/**
 * SkillRouter：根据用户请求选择最小充分技能集合。
 *
 * 触发来源：用户显式指定 / description 语义匹配 / Agent 选择 / Plugin 固定 / 项目类型。
 * 本模块只消费「name + description + whenToUse」元数据，绝不预载 SKILL.md 全文。
 * 返回每次激活的 reason 与可审计说明，供 Run 记录与用户纠正。
 */

import { tokenize } from "../util.js";

const DEFAULT_SCORE_THRESHOLD = 0.2;
const MAX_AUTO_SKILLS = 3;

/** 停用词（中英）：不参与匹配打分，降低噪声。 */
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "to", "of", "for", "and", "or", "in", "on", "with",
  "我", "你", "他", "她", "它", "的", "了", "是", "在", "和", "与", "或", "要", "想", "请", "帮",
  "一下", "一个", "这个", "那个", "用", "做", "个", "就", "都", "也", "可以", "能", "会", "不",
]);

/** 从技能名 + 描述构造检索 token 集。 */
function skillTokens(summary) {
  const text = [summary.name, summary.description, summary.whenToUse].filter(Boolean).join(" ");
  return new Set(tokenize(text).filter((t) => !STOPWORDS.has(t)));
}

/** 覆盖率打分（0..1）：请求 token 被技能描述命中的比例。可替换为 BM25/embedding，接口不变。 */
function score(requestTokens, skillTokenSet) {
  if (requestTokens.length === 0 || skillTokenSet.size === 0) return 0;
  let hit = 0;
  for (const t of requestTokens) {
    if (skillTokenSet.has(t)) hit += 1;
  }
  return hit / requestTokens.length;
}

/** 检测用户显式点名技能。 */
function explicitName(request, catalog) {
  const lower = request.toLowerCase();
  // 1) 直接点名：`使用 pdf-processing` / `run skill x` / 技能名出现在请求中
  const byName = catalog.find((s) => lower.includes(s.name.toLowerCase()));
  if (byName) return byName;
  // 2) 中文模式：`用 X 技能`
  for (const s of catalog) {
    if (new RegExp(`用\\s*${escapeRegExp(s.name)}\\s*(技能)?`).test(request)) return s;
  }
  return null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 选择技能。
 * @param {string} request 用户请求文本
 * @param {Array<object>} catalog 已启用技能的元数据摘要（registry.list()）
 * @param {{explicit?: string[], projectType?: string, threshold?: number}} [opts]
 * @returns {Array<{skillId, name, version, reason, score, explanation}>}
 */
export function selectSkills(request, catalog, opts = {}) {
  const enabled = catalog.filter((s) => s.enabled !== false);
  const requestTokens = tokenize(request || "").filter((t) => !STOPWORDS.has(t));

  const results = [];
  const add = (s, reason, score, explanation) => {
    if (results.some((r) => r.name === s.name)) return;
    results.push({
      skillId: s.id,
      name: s.name,
      version: s.version,
      reason,
      score,
      explanation,
    });
  };

  // 1) 显式指定（用户或 Agent 传参）
  const explicitIds = opts.explicit || [];
  for (const name of explicitIds) {
    const s = enabled.find((x) => x.name === name);
    if (s) add(s, "explicit", 1, `用户/Agent 显式指定技能 ${name}`);
  }

  // 2) 用户消息里直接点名
  const named = explicitName(request || "", enabled);
  if (named) add(named, "explicit", 1, `用户请求中点名技能 ${named.name}`);

  // 3) description 语义匹配（token 重叠）
  if (requestTokens.length > 0) {
    const scored = enabled
      .map((s) => ({ s, sc: score(requestTokens, skillTokens(s)) }))
      .filter((x) => x.sc >= (opts.threshold ?? DEFAULT_SCORE_THRESHOLD))
      .sort((a, b) => b.sc - a.sc);
    for (const { s, sc } of scored.slice(0, MAX_AUTO_SKILLS)) {
      add(s, "semantic", round(sc), `请求与技能 ${s.name} 的 description 语义匹配（得分 ${round(sc)}）`);
    }
  }

  // 4) 项目类型要求（Godot/网页 等，作为固定触发）
  if (opts.projectType) {
    const pt = String(opts.projectType).toLowerCase();
    for (const s of enabled) {
      const tags = `${s.name} ${s.description} ${s.whenToUse ?? ""}`.toLowerCase();
      if (pt.includes(s.name) || tags.includes(pt)) {
        add(s, "project-type", 1, `项目类型 ${pt} 要求技能 ${s.name}`);
      }
    }
  }

  return results;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
