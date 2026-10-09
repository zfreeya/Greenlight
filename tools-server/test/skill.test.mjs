/**
 * Skill 系统单元 + 安全测试（node:test）。
 * 覆盖：frontmatter 解析/校验、渐进式披露、路由、安装（folder/zip/git）、
 * 路径穿越、符号链接逃逸、资源读取越界。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

import { parseSkillFrontmatter, harnessExtensions, splitFrontmatter } from "../lib/skill/frontmatter.js";
import { discoverSkillDir, loadSkillBody, loadSkillResource } from "../lib/skill/layout.js";
import { selectSkills } from "../lib/skill/router.js";
import { installSkill, uninstallSkill, analyzeSkillDir } from "../lib/skill/install.js";
import { tokenize, assertSafeRelativeName, isInside } from "../lib/util.js";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-test-"));
}

function writeSkill(dir, { name = "my-skill", description = "测试技能", extra = "", body = "# 正文\n" } = {}) {
  const front = `---\nname: ${name}\ndescription: ${description}\n${extra}---\n`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), front + body, "utf8");
  return dir;
}

/* ---------------- frontmatter ---------------- */

test("解析标准 6 字段 frontmatter", () => {
  const raw = `---\nname: pdf-tools\ndescription: 处理 PDF\nlicense: MIT\ncompatibility: ["harness>=0.1"]\nmetadata:\n  harness.publisher: example\nallowed-tools: [read, write]\n---\n# 正文\n`;
  const p = parseSkillFrontmatter(raw);
  assert.equal(p.name, "pdf-tools");
  assert.equal(p.description, "处理 PDF");
  assert.equal(p.license, "MIT");
  assert.deepEqual(p.compatibility, ["harness>=0.1"]);
  assert.deepEqual(p.allowedTools, ["read", "write"]);
  assert.equal(p.content, "# 正文");
});

test("harness 扩展：嵌套与点号键两种写法都支持", () => {
  const nested = parseSkillFrontmatter(`---\nname: a\ndescription: b\nmetadata:\n  harness:\n    capabilities: "x.y z.w"\n    publisher: p1\n---\n`);
  const dotted = parseSkillFrontmatter(`---\nname: a\ndescription: b\nmetadata:\n  harness.capabilities: "x.y z.w"\n  harness.publisher: p1\n---\n`);
  assert.deepEqual(harnessExtensions(nested).capabilities, ["x.y", "z.w"]);
  assert.equal(harnessExtensions(nested).publisher, "p1");
  assert.deepEqual(harnessExtensions(dotted).capabilities, ["x.y", "z.w"]);
  assert.equal(harnessExtensions(dotted).publisher, "p1");
});

test("非法 frontmatter：缺 name / 缺 description / 非法名 / 坏 YAML 均拒绝", () => {
  assert.throws(() => parseSkillFrontmatter(`---\ndescription: x\n---\n`), /name/);
  assert.throws(() => parseSkillFrontmatter(`---\nname: a\n---\n`), /description/);
  assert.throws(() => parseSkillFrontmatter(`---\nname: BadName\ndescription: x\n---\n`), /kebab-case/);
  assert.throws(() => parseSkillFrontmatter(`---\nname: [unclosed\ndescription: x\n---\n`), /YAML/);
});

test("缺 frontmatter 直接返回 null", () => {
  assert.equal(splitFrontmatter("# 无 frontmatter"), null);
});

/* ---------------- 分词与路由 ---------------- */

test("中文分词 + 语义匹配", () => {
  assert.deepEqual(tokenize("帮我发布一个网页报告"), ["发布", "一个", "网页", "报告"]);
  const catalog = [{
    id: "s1", name: "web-publish", version: "1.0.0", enabled: true,
    description: "把一个已有的 HTML/Markdown 成果发布为可预览的网页，用于发布网页生成报告页面",
  }];
  const acts = selectSkills("帮我发布一个网页报告", catalog);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].name, "web-publish");
  assert.equal(acts[0].reason, "semantic");
});

test("显式点名优先 + 无关请求不命中", () => {
  const catalog = [{
    id: "s1", name: "web-publish", version: "1.0.0", enabled: true,
    description: "发布网页",
  }];
  assert.equal(selectSkills("写个贪吃蛇游戏", catalog).length, 0);
  const explicit = selectSkills("请用 web-publish 技能", catalog);
  assert.equal(explicit[0].reason, "explicit");
});

/* ---------------- 渐进式披露 ---------------- */

test("三级加载：元数据不载全文，正文/资源按需读，资源越界拒绝", () => {
  const dir = tmpdir();
  const skillDir = path.join(dir, "doc-gen");
  writeSkill(skillDir, { name: "doc-gen", description: "生成文档", extra: "license: Apache-2.0\n" });
  fs.mkdirSync(path.join(skillDir, "references"));
  fs.writeFileSync(path.join(skillDir, "references/guide.md"), "REF-BODY", "utf8");

  const summary = discoverSkillDir(skillDir);
  assert.equal(summary.name, "doc-gen");
  assert.equal(summary.content, undefined); // 元数据层不含正文
  assert.deepEqual(summary.resources.references, ["references/guide.md"]);

  const body = loadSkillBody(skillDir);
  assert.ok(body.content.includes("正文"));

  assert.equal(loadSkillResource(skillDir, "references/guide.md"), "REF-BODY");
  assert.equal(loadSkillResource(skillDir, "../outside.txt"), null); // 越界拒绝
});

/* ---------------- 安装：folder ---------------- */

test("folder 安装到版本化目录并更新索引", async () => {
  const dir = tmpdir();
  const skillDir = path.join(dir, "src");
  writeSkill(skillDir, { name: "doc-gen", description: "生成文档", extra: "license: MIT\nversion: 1.2.3\n" });
  const index = { byId: {}, byName: {} };
  const { installed } = await installSkill({ source: { kind: "folder", path: skillDir }, skillsRoot: path.join(dir, "skills"), index, trustLevel: "local" });
  assert.equal(installed.name, "doc-gen");
  assert.equal(installed.version, "1.2.3");
  assert.ok(installed.installPath.includes(path.join("skills", "doc-gen", "1.2.3")));
  assert.ok(fs.existsSync(path.join(installed.installPath, "SKILL.md")));
  assert.equal(index.byName["doc-gen"], installed.id);
});

/* ---------------- 安全：zip 路径穿越 ---------------- */

test("ZIP 路径穿越被拒绝（../ 条目）", async () => {
  const dir = tmpdir();
  const zipPath = path.join(dir, "evil.zip");
  // 用 python3 造含 ../ 条目的 zip（zip 命令会规范化，python 不会）
  try {
    execFileSync("python3", ["-c", `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], "w")
z.writestr("../evil.txt", "pwned")
z.writestr("skill/SKILL.md", "---\\nname: a\\ndescription: b\\n---\\n")
z.close()
`, zipPath], { encoding: "utf8" });
  } catch {
    // 无 python3 时跳过
    return;
  }
  const index = { byId: {}, byName: {} };
  // yauzl 自身已拒绝 `..`（第一层）；Harness 的 isInside/assertSafeRelativeName 是第二层。
  await assert.rejects(
    installSkill({ source: { kind: "zip", path: zipPath }, skillsRoot: path.join(dir, "skills"), index, trustLevel: "local" }),
    /(路径穿越|invalid relative path|逃逸)/,
  );
});

/* ---------------- 安全：符号链接逃逸 ---------------- */

test("folder 安装拒绝符号链接逃逸", async () => {
  const dir = tmpdir();
  const outside = path.join(dir, "secret.txt");
  fs.writeFileSync(outside, "SECRET", "utf8");
  const skillDir = path.join(dir, "src");
  writeSkill(skillDir, { name: "doc-gen", description: "生成文档" });
  fs.symlinkSync(outside, path.join(skillDir, "escape-link")); // 指向目录外
  const index = { byId: {}, byName: {} };
  await assert.rejects(
    installSkill({ source: { kind: "folder", path: skillDir }, skillsRoot: path.join(dir, "skills"), index, trustLevel: "local" }),
    /符号链接逃逸/,
  );
});

/* ---------------- 路径安全原语 ---------------- */

test("assertSafeRelativeName 拒绝绝对路径与 ..", () => {
  assert.throws(() => assertSafeRelativeName("/etc/passwd"), /绝对路径/);
  assert.throws(() => assertSafeRelativeName("../etc"), /逃逸/);
  assert.throws(() => assertSafeRelativeName("a/../../b"), /逃逸/);
  assert.equal(assertSafeRelativeName("a/b/c.md"), "a/b/c.md");
});

test("isInside 正确判定包含关系", () => {
  const root = "/root/dir";
  assert.equal(isInside(root, "/root/dir/a/b"), true);
  assert.equal(isInside(root, "/root/dir"), false);
  assert.equal(isInside(root, "/root/other"), false);
});

/* ---------------- 卸载 ---------------- */

test("卸载删除版本目录并回退同名旧版本", async () => {
  const dir = tmpdir();
  const skillsRoot = path.join(dir, "skills");
  const index = { byId: {}, byName: {} };
  const v1 = path.join(dir, "v1");
  const v2 = path.join(dir, "v2");
  writeSkill(v1, { name: "doc-gen", description: "生成文档", extra: "version: 1.0.0\n" });
  writeSkill(v2, { name: "doc-gen", description: "生成文档", extra: "version: 2.0.0\n" });
  await installSkill({ source: { kind: "folder", path: v1 }, skillsRoot, index, trustLevel: "local" });
  await installSkill({ source: { kind: "folder", path: v2 }, skillsRoot, index, trustLevel: "local" });
  const newest = index.byName["doc-gen"];
  assert.equal(index.byId[newest].version, "2.0.0");
  const removed = uninstallSkill({ skillsRoot, index, id: newest });
  assert.equal(removed.version, "2.0.0");
  assert.equal(index.byName["doc-gen"] !== newest, true);
  assert.equal(index.byId[index.byName["doc-gen"]].version, "1.0.0");
});
