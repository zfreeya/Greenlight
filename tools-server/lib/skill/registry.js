/**
 * SkillRegistry：技能索引 + 启用/禁用 + 渐进式读取入口。
 * 索引持久化到 <dataDir>/skills-index.json。
 */

import path from "node:path";
import fs from "node:fs";
import { readJson, writeJson, mkdirp } from "../util.js";
import { discoverSkillDir, loadSkillBody, loadSkillResource } from "./layout.js";

export class SkillRegistry {
  /** @param {string} skillsRoot 版本化安装根（<root>/<name>/<version>/） */
  constructor({ skillsRoot, dataDir }) {
    this.skillsRoot = skillsRoot;
    this.dataDir = dataDir;
    this.indexFile = path.join(dataDir, "skills-index.json");
    mkdirp(skillsRoot);
    mkdirp(dataDir);
    this.index = readJson(this.indexFile, { byId: {}, byName: {} });
    if (!this.index.byId) this.index.byId = {};
    if (!this.index.byName) this.index.byName = {};
  }

  persist() {
    writeJson(this.indexFile, this.index);
  }

  /** 已安装技能元数据摘要（仅 name/description，供路由与 UI）。 */
  list() {
    const seen = new Set();
    const out = [];
    for (const id of Object.values(this.index.byName)) {
      const rec = this.index.byId[id];
      if (!rec || seen.has(rec.name)) continue;
      seen.add(rec.name);
      out.push(this.toSummary(rec));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 全部已安装记录（含多版本）。 */
  listAll() {
    return Object.values(this.index.byId).map((r) => this.toSummary(r));
  }

  toSummary(rec) {
    const m = rec.manifest || {};
    return {
      id: rec.id,
      name: rec.name,
      version: rec.version,
      description: m.description,
      whenToUse: m.whenToUse,
      license: rec.license,
      publisher: rec.publisher,
      origin: rec.origin,
      source: rec.source,
      trustLevel: rec.trustLevel,
      status: rec.status,
      scope: rec.scope,
      enabled: rec.enabled,
      capabilities: m.capabilities || [],
      allowedTools: m.allowedTools || [],
      resources: m.resources || {},
      requestedPermissions: rec.requestedPermissions || [],
      installedAt: rec.installedAt,
      updatedAt: rec.updatedAt,
    };
  }

  get(id) {
    return this.index.byId[id] || null;
  }

  getByName(name) {
    const id = this.index.byName[name];
    return id ? this.index.byId[id] : null;
  }

  setEnabled(id, enabled) {
    const rec = this.get(id);
    if (!rec) throw new Error("技能不存在：" + id);
    rec.enabled = enabled;
    rec.status = enabled ? "installed" : "disabled";
    rec.updatedAt = Date.now();
    this.persist();
    return this.toSummary(rec);
  }

  setTrustLevel(id, trustLevel) {
    const rec = this.get(id);
    if (!rec) throw new Error("技能不存在：" + id);
    rec.trustLevel = trustLevel;
    rec.updatedAt = Date.now();
    this.persist();
    return this.toSummary(rec);
  }

  /** 第二级：加载 SKILL.md 正文（仅选中后）。 */
  loadBody(name) {
    const rec = this.getByName(name);
    if (!rec || !rec.enabled) return null;
    const body = loadSkillBody(rec.installPath);
    if (!body) return null;
    return {
      id: rec.id,
      name: rec.name,
      version: rec.version,
      license: rec.license,
      trustLevel: rec.trustLevel,
      capabilities: rec.manifest?.capabilities || [],
      allowedTools: rec.manifest?.allowedTools || [],
      content: body.content,
    };
  }

  /** 第三级：读取资源（references/scripts/assets）。 */
  loadResource(name, rel) {
    const rec = this.getByName(name);
    if (!rec || !rec.enabled) return null;
    return loadSkillResource(rec.installPath, rel);
  }

  /** 重新发现已安装目录（容错：索引丢失时从磁盘重建）。 */
  rescan() {
    let entries;
    try { entries = fs.readdirSync(this.skillsRoot); } catch { return 0; }
    let count = 0;
    for (const name of entries) {
      const nameDir = path.join(this.skillsRoot, name);
      let versions;
      try { versions = fs.readdirSync(nameDir); } catch { continue; }
      for (const v of versions) {
        const vDir = path.join(nameDir, v);
        const summary = discoverSkillDir(vDir);
        if (!summary) continue;
        const id = require("node:crypto").createHash("sha1").update(`${summary.name}|${v}`).digest("hex").slice(0, 12);
        if (this.index.byId[id]) continue;
        this.index.byId[id] = {
          id, name: summary.name, version: v, origin: "folder",
          source: { kind: "folder", path: vDir }, installPath: vDir,
          trustLevel: "local", status: "installed", scope: "global",
          license: summary.license, publisher: summary.publisher,
          enabled: true, manifest: summary, requestedPermissions: [],
          installedAt: Date.now(), updatedAt: Date.now(),
        };
        this.index.byName[summary.name] = id;
        count++;
      }
    }
    if (count) this.persist();
    return count;
  }
}
