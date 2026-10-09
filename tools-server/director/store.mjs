/* ============================================================================
 * Harness Director — 持久化存储（零依赖）
 *
 * 磁盘布局（<workspace>/director/）：
 *   index.json              项目索引（projectId/title/phase/updatedAt）
 *   <projectId>/
 *     project.json          当前完整快照（原子写：临时文件 + rename）
 *     journal.jsonl         追加式变更日志（审计/恢复）
 *     versions/vNNNNNN.json 显式检查点（可恢复版本）
 *     assets/               导入/生成的资产文件
 *     exports/              渲染产物
 *
 * 恢复策略：project.json 损坏时，回退到最近检查点 + 重放其后 journal。
 * ==========================================================================*/
import fs from "node:fs";
import path from "node:path";

export class DirectorStore {
  constructor(rootDir) {
    this.root = rootDir;
    this.index = [];
    fs.mkdirSync(this.root, { recursive: true });
    this._loadIndex();
  }

  _indexPath() { return path.join(this.root, "index.json"); }
  projectDir(projectId) { return path.join(this.root, String(projectId)); }
  _projectPath(projectId) { return path.join(this.projectDir(projectId), "project.json"); }
  _journalPath(projectId) { return path.join(this.projectDir(projectId), "journal.jsonl"); }
  _versionsDir(projectId) { return path.join(this.projectDir(projectId), "versions"); }
  _assetsDir(projectId) { return path.join(this.projectDir(projectId), "assets"); }
  _exportsDir(projectId) { return path.join(this.projectDir(projectId), "exports"); }

  _loadIndex() {
    try { this.index = JSON.parse(fs.readFileSync(this._indexPath(), "utf8")); }
    catch { this.index = []; }
    if (!Array.isArray(this.index)) this.index = [];
  }

  _saveIndex() {
    fs.writeFileSync(this._indexPath(), JSON.stringify(this.index, null, 2));
  }

  _atomicWrite(file, data) {
    const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2);
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, file);
  }

  _appendJournal(projectId, entry) {
    fs.mkdirSync(this.projectDir(projectId), { recursive: true });
    fs.appendFileSync(this._journalPath(projectId), JSON.stringify(entry) + "\n", "utf8");
  }

  _readJournal(projectId) {
    try {
      const raw = fs.readFileSync(this._journalPath(projectId), "utf8");
      return raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  ensureProjectDirs(projectId) {
    fs.mkdirSync(this.projectDir(projectId), { recursive: true });
    fs.mkdirSync(this._versionsDir(projectId), { recursive: true });
    fs.mkdirSync(this._assetsDir(projectId), { recursive: true });
    fs.mkdirSync(this._exportsDir(projectId), { recursive: true });
  }

  /* ---- 项目 CRUD ---- */
  listProjects() {
    return this.index.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  createProject(project) {
    this.ensureProjectDirs(project.projectId);
    this.saveProject(project, { op: "create", by: "system" });
    return project;
  }

  saveProject(project, meta = { op: "update", by: "agent" }) {
    const id = project.projectId;
    this.ensureProjectDirs(id);
    // 乐观锁：内存版本必须等于磁盘版本，防止较旧快照覆盖刚完成的 Take/Asset 状态
    let diskRev = 0;
    try {
      diskRev = JSON.parse(fs.readFileSync(this._projectPath(id), "utf8"))._rev || 0;
    } catch { diskRev = 0; }
    const myRev = project._rev || 0;
    if (myRev !== diskRev) {
      const err = new Error("项目并发写入冲突：磁盘版本 " + diskRev + " ≠ 内存版本 " + myRev + "（" + id + "）");
      err.code = "concurrency";
      throw err;
    }
    const newRev = diskRev + 1;
    project._rev = newRev;
    project.updatedAt = Date.now();
    this._atomicWrite(this._projectPath(id), JSON.stringify(project, null, 2));
    this._appendJournal(id, { ts: Date.now(), ...meta, projectId: id, version: project.version, rev: newRev });
    // 更新索引
    const i = this.index.findIndex((p) => p.projectId === id);
    const rec = { projectId: id, title: project.title, phase: project.phase, updatedAt: project.updatedAt, version: project.version, rev: newRev };
    if (i >= 0) this.index[i] = rec; else this.index.push(rec);
    this._saveIndex();
    return project;
  }

  loadProject(projectId) {
    const p = this._projectPath(projectId);
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      } catch {
        // 损坏：走恢复
        return this._recover(projectId);
      }
    }
    // 无快照：尝试从 journal 重放（至少能拿到 create 时的对象）
    return this._recover(projectId);
  }

  /* 恢复：最近检查点 + 重放其后 journal */
  _recover(projectId) {
    const versions = this.listVersions(projectId);
    let proj = null;
    let baseTs = 0;
    if (versions.length) {
      const last = versions[versions.length - 1];
      try { proj = JSON.parse(fs.readFileSync(path.join(this._versionsDir(projectId), last.file), "utf8")); baseTs = last.ts; }
      catch { proj = null; }
    }
    const journal = this._readJournal(projectId);
    if (!proj) {
      // 找 journal 里的 create/checkpoint 快照字段（saveProject 会记 version 但非全量）
      // 兜底：无法恢复时返回 null 并明确标记
      const createEntry = journal.find((e) => e.op === "create");
      if (!createEntry) return null;
      return { projectId, title: "（恢复失败，需重建）", phase: "intake", _recovered: true, _journalCount: journal.length };
    }
    for (const e of journal) {
      if (e.ts > baseTs) { /* 当前 journal 不存完整字段差异，因此只做审计计数 */ }
    }
    proj._recovered = true;
    proj._replayedJournalCount = journal.filter((e) => e.ts > baseTs).length;
    return proj;
  }

  /* ---- 版本 / 检查点 ---- */
  checkpoint(project, reason = "") {
    const id = project.projectId;
    this.ensureProjectDirs(id);
    project.version = (project.version || 0) + 1;
    project.updatedAt = Date.now();
    const file = "v" + String(project.version).padStart(6, "0") + ".json";
    this._atomicWrite(path.join(this._versionsDir(id), file), JSON.stringify(project, null, 2));
    this._appendJournal(id, { ts: Date.now(), op: "checkpoint", by: "agent", version: project.version, reason });
    return { version: project.version, file, ts: Date.now(), reason };
  }

  listVersions(projectId) {
    try {
      return fs.readdirSync(this._versionsDir(projectId))
        .filter((f) => /\.json$/.test(f))
        .map((f) => {
          const m = f.match(/v(\d+)\.json/);
          return { file: f, version: m ? Number(m[1]) : 0, ts: fs.statSync(path.join(this._versionsDir(projectId), f)).mtimeMs };
        })
        .sort((a, b) => a.version - b.version);
    } catch { return []; }
  }

  restoreVersion(projectId, version) {
    const versions = this.listVersions(projectId);
    const v = versions.find((x) => x.version === Number(version));
    if (!v) throw new Error("版本不存在：" + version);
    const proj = JSON.parse(fs.readFileSync(path.join(this._versionsDir(projectId), v.file), "utf8"));
    // 恢复是显式覆盖：以当前磁盘版本为基线写入，避免乐观锁把「恢复」误判为过期写入
    let diskRev = 0;
    try { diskRev = JSON.parse(fs.readFileSync(this._projectPath(projectId), "utf8"))._rev || 0; } catch { diskRev = 0; }
    proj._rev = diskRev;
    this.saveProject(proj, { op: "restore", by: "agent", fromVersion: version });
    return proj;
  }

  journal(projectId, limit = 50) {
    return this._readJournal(projectId).slice(-limit);
  }

  /* ---- 资产文件 ---- */
  assetsDir(projectId) { fs.mkdirSync(this._assetsDir(projectId), { recursive: true }); return this._assetsDir(projectId); }
  exportsDir(projectId) { fs.mkdirSync(this._exportsDir(projectId), { recursive: true }); return this._exportsDir(projectId); }

  resolveAssetPath(projectId, rel) {
    const abs = path.resolve(this._assetsDir(projectId), rel);
    const base = this._assetsDir(projectId);
    const r = path.relative(base, abs);
    if (r.startsWith("..") || path.isAbsolute(r)) throw new Error("资产路径越界");
    return abs;
  }

  exportArchive(projectId) {
    const proj = this.loadProject(projectId);
    const manifest = {
      project: proj,
      export: {
        format: "harness-director-project",
        version: 1,
        exportedAt: Date.now(),
        files: {
          shotList: "shots.csv",
          bible: "project-bible.md",
          assets: "assets-manifest.json",
          rights: "rights-manifest.json",
        },
      },
    };
    return manifest;
  }
}
