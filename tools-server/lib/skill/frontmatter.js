/**
 * SKILL.md YAML Frontmatter 解析与校验（兼容 agentskills 标准）。
 *
 * 标准字段：name、description、license、compatibility、metadata、allowed-tools。
 * 可选字段：version、whenToUse。
 * Harness 自有扩展一律落在 `metadata.harness.*` 命名空间，不破坏标准兼容。
 */

import { parse as parseYaml } from "yaml";

/** kebab-case 技能名语法（与标准一致，允许数字与连字符） */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 描述长度上限：路由描述必须精炼，过长的正文不应进 frontmatter description */
export const DESCRIPTION_MAX = 1024;

/**
 * 提取 frontmatter：必须首行 `---`，随后 YAML，至下一个独占 `---` 行结束。
 * @returns {{ data: Record<string, unknown>, body: string, bodyOffset: number } | null}
 */
export function splitFrontmatter(raw) {
  if (typeof raw !== "string") return null;
  const firstEol = raw.indexOf("\n");
  const firstLine = firstEol < 0 ? raw : raw.slice(0, firstEol);
  if (firstLine.replace(/\r$/, "") !== "---") return null;
  const start = firstEol < 0 ? raw.length : firstEol + 1;
  // 逐行找结束 `---`
  let lineStart = start;
  while (lineStart <= raw.length) {
    const nl = raw.indexOf("\n", lineStart);
    const lineEnd = nl < 0 ? raw.length : nl;
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (line === "---") {
      const bodyStart = nl < 0 ? raw.length : nl + 1;
      return { data: raw.slice(start, lineStart), body: raw.slice(bodyStart), bodyOffset: bodyStart };
    }
    if (nl < 0) return null;
    lineStart = nl + 1;
  }
  return null;
}

/** 把字符串或数组统一为字符串数组；空值返回 undefined。 */
function asStringList(value, key) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const t = value.trim();
    return t ? [t] : undefined;
  }
  if (Array.isArray(value)) {
    const out = value.filter((v) => typeof v === "string" && v.length > 0);
    return out.length ? out : undefined;
  }
  throw new Error(`frontmatter 字段 "${key}" 必须是字符串或字符串数组`);
}

function asString(value, key) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`frontmatter 字段 "${key}" 必须是字符串`);
  const t = value.trim();
  return t.length ? t : undefined;
}

/** 解析并校验 SKILL.md 文本。返回结构化结果；非法时抛错（调用方决定丢弃/隔离）。 */
export function parseSkillFrontmatter(raw, { sourceLabel = "SKILL.md" } = {}) {
  const split = splitFrontmatter(raw);
  if (!split) throw new Error(`${sourceLabel} 缺少 YAML frontmatter（首行须为 ---）`);

  let data;
  try {
    const parsed = parseYaml(split.data);
    data = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    throw new Error(`${sourceLabel} frontmatter YAML 解析失败：${e.message}`);
  }

  const name = asString(data.name, "name");
  if (!name) throw new Error(`${sourceLabel} frontmatter 缺少 name`);
  if (!SKILL_NAME_RE.test(name)) throw new Error(`${sourceLabel} 非法技能名 "${name}"（须为 kebab-case）`);

  const description = asString(data.description, "description");
  if (!description) throw new Error(`${sourceLabel} frontmatter 缺少 description`);
  if (description.length > DESCRIPTION_MAX) {
    throw new Error(`${sourceLabel} description 过长（>${DESCRIPTION_MAX}）`);
  }

  // 可选字段
  const license = asString(data.license, "license");
  const version = asString(data.version, "version");
  const whenToUse = asString(data.whenToUse, "whenToUse");
  const compatibility = asStringList(data.compatibility, "compatibility");
  const allowedTools = asStringList(data["allowed-tools"] ?? data.allowedTools, "allowed-tools");

  // metadata 命名空间（对象），保留 harness.* 扩展
  let metadata;
  const rawMeta = data.metadata;
  if (rawMeta !== undefined) {
    if (typeof rawMeta !== "object" || rawMeta === null || Array.isArray(rawMeta)) {
      throw new Error(`${sourceLabel} metadata 必须是对象`);
    }
    metadata = rawMeta;
  }

  return {
    name,
    description,
    version,
    whenToUse,
    license,
    compatibility,
    allowedTools,
    metadata,
    content: split.body.trim(),
  };
}

/** 提取 metadata.harness.* 扩展字段（capabilities / publisher / version 等）。
 *  兼容两种 YAML 写法：
 *   - 嵌套：`metadata: { harness: { capabilities: "..." } }`
 *   - 点号键：`metadata: { "harness.capabilities": "..." }`（与规格示例一致）
 */
export function harnessExtensions(parsed) {
  const meta = (parsed && parsed.metadata) || {};
  const h = {};
  if (meta && typeof meta.harness === "object" && meta.harness !== null) Object.assign(h, meta.harness);
  for (const [k, v] of Object.entries(meta || {})) {
    if (k.startsWith("harness.")) h[k.slice("harness.".length)] = v;
  }
  return {
    /** 能力列表：space 分隔字符串或数组 */
    capabilities: normalizeCapabilities(h.capabilities),
    publisher: typeof h.publisher === "string" ? h.publisher : undefined,
    harnessVersion: h.version,
  };
}

/** 能力声明统一为字符串数组（`"video.generate video.poll"` → 数组）。 */
export function normalizeCapabilities(input) {
  if (input === undefined || input === null) return [];
  if (Array.isArray(input)) return input.filter((x) => typeof x === "string" && x.length > 0);
  if (typeof input === "string") {
    return input.trim().split(/[\s,]+/).filter(Boolean);
  }
  return [];
}
