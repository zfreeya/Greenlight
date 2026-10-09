/* ============================================================================
 * Harness Director — AssetUploader 抽象（零依赖 + node:sqlite）
 *
 * 本地参考素材（首帧图 / 尾帧图 / 参考图片 / 参考视频 / 参考音频）不能把磁盘
 * 绝对路径直接发给远程 API。这里抽象出三种上传形态：
 *   - remote_url：素材本身已是远程 URL（用户提供或此前上传），校验 + 过期跟踪；
 *   - data_uri  ：小文件直接内联为 Data URI（仅在官方限制允许且文件足够小时）；
 *   - tos       ：上传到火山 TOS，返回预签名 URL（最小权限 / 临时凭证 / 不落长期
 *                 AK/SK；由 Python worker 执行真实上传）。
 *
 * 上传结果与素材哈希建立缓存：相同文件不重复上传；清楚暴露「是否已上传」与
 * 「URL 何时过期」。
 * ==========================================================================*/
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const ASSET_UPLOAD_KINDS = ["remote_url", "tos", "data_uri"];

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
export function fileSha256(absPath) { return sha256(fs.readFileSync(absPath)); }

/** 由扩展名给出 MIME（白名单，避免任意内容被内联）。 */
const EXT_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".mp4": "video/mp4", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};
function mimeFor(p) { return EXT_MIME[path.extname(String(p)).toLowerCase()] || "application/octet-stream"; }

export class AssetUploader {
  /**
   * @param {object} opts
   * @param {string} opts.dbFile         上传缓存 SQLite 文件路径
   * @param {number} [opts.maxDataUriBytes] Data URI 内联上限（默认 512KB）
   * @param {object} [opts.worker]       可选：Python worker 的 tos_upload RPC 封装
   */
  constructor(opts) {
    this.dbFile = opts.dbFile;
    this.maxDataUriBytes = opts.maxDataUriBytes ?? 512 * 1024;
    this.worker = opts.worker || null;
    if (opts.dbFile && opts.dbFile !== ":memory:") fs.mkdirSync(path.dirname(opts.dbFile), { recursive: true });
    this.db = new DatabaseSync(opts.dbFile || ":memory:");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS asset_upload_cache (
        file_hash   TEXT PRIMARY KEY,
        asset_id    TEXT NOT NULL,
        kind        TEXT NOT NULL,
        url         TEXT NOT NULL,
        expires_at  INTEGER,
        uploaded    INTEGER NOT NULL DEFAULT 1,
        reason      TEXT,
        created_at  INTEGER NOT NULL
      );
    `);
  }

  _lookup(hash) {
    const row = this.db.prepare("SELECT * FROM asset_upload_cache WHERE file_hash = ?").get(hash);
    if (!row) return null;
    if (row.expires_at && row.expires_at < Date.now()) return null; // 已过期 → 需重传
    return row;
  }

  _record(hash, rec) {
    this.db.prepare(`
      INSERT OR REPLACE INTO asset_upload_cache
        (file_hash, asset_id, kind, url, expires_at, uploaded, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(hash, String(rec.assetId ?? ""), String(rec.kind ?? ""), String(rec.url ?? ""),
      rec.expiresAt ?? null, rec.uploaded ? 1 : 0, rec.reason ?? null, Date.now());
  }

  /**
   * 为一条本地参考素材准备远程引用。
   * @param {object} asset { assetId, localPath, kind?, role? }
   * @returns {Promise<object>} { assetId, type, url, expiresAt, uploaded, cacheHit, reason }
   */
  async prepareReference(asset) {
    const localPath = asset.localPath;
    if (!localPath || !fs.existsSync(localPath)) {
      return { assetId: asset.assetId, type: "remote_url", url: "", uploaded: false, cacheHit: false, reason: "本地文件不存在：" + localPath };
    }
    const hash = fileSha256(localPath);
    const cached = this._lookup(hash);
    if (cached && cached.uploaded) {
      return { assetId: asset.assetId, type: cached.kind, url: cached.url, expiresAt: cached.expires_at || null, uploaded: true, cacheHit: true, reason: "命中上传缓存" };
    }

    const kind = asset.kind || this._defaultKind(localPath, asset.role);
    if (kind === "remote_url" && /^https?:\/\//i.test(String(asset.remoteUrl || ""))) {
      const rec = { assetId: asset.assetId, kind: "remote_url", url: asset.remoteUrl, expiresAt: asset.expiresAt || null, uploaded: true };
      this._record(hash, rec);
      return { assetId: asset.assetId, type: "remote_url", url: rec.url, expiresAt: rec.expiresAt || null, uploaded: true, cacheHit: false, reason: "远程 URL 直接引用" };
    }

    if (kind === "data_uri") {
      const size = fs.statSync(localPath).size;
      if (size > this.maxDataUriBytes) {
        return { assetId: asset.assetId, type: "data_uri", url: "", uploaded: false, cacheHit: false, reason: `文件 ${size} 字节超过 Data URI 内联上限 ${this.maxDataUriBytes}，请改用 TOS 上传` };
      }
      const b64 = fs.readFileSync(localPath).toString("base64");
      const url = "data:" + mimeFor(localPath) + ";base64," + b64;
      this._record(hash, { assetId: asset.assetId, kind: "data_uri", url, uploaded: true });
      return { assetId: asset.assetId, type: "data_uri", url, uploaded: true, cacheHit: false, reason: "已内联为 Data URI（小文件）" };
    }

    if (kind === "tos") {
      if (!this.worker) {
        return { assetId: asset.assetId, type: "tos", url: "", uploaded: false, cacheHit: false, reason: "TOS 上传未配置（缺少临时凭证或预签名 URL）" };
      }
      try {
        const r = await this.worker.tosUpload(localPath, { mime: mimeFor(localPath), fileHash: hash });
        if (r && r.ok && r.url) {
          const rec = { assetId: asset.assetId, kind: "tos", url: r.url, expiresAt: r.expiresAt || null, uploaded: true };
          this._record(hash, rec);
          return { assetId: asset.assetId, type: "tos", url: r.url, expiresAt: r.expiresAt || null, uploaded: true, cacheHit: false, reason: "已上传 TOS（预签名 URL）" };
        }
        return { assetId: asset.assetId, type: "tos", url: "", uploaded: false, cacheHit: false, reason: r?.reason || r?.error || "TOS 上传失败" };
      } catch (e) {
        return { assetId: asset.assetId, type: "tos", url: "", uploaded: false, cacheHit: false, reason: "TOS 上传异常：" + String(e?.message ?? e) };
      }
    }

    return { assetId: asset.assetId, type: kind, url: "", uploaded: false, cacheHit: false, reason: "未知上传形态：" + kind };
  }

  _defaultKind(localPath, role) {
    // 参考音频/视频通常更大 → 走 TOS；小图可内联。默认策略：优先 remote_url 已给；否则 tos。
    return "tos";
  }

  /** 查询某素材当前上传状态（供 UI 展示「是否已上传 / 何时过期」）。 */
  status(assetId) {
    const rows = this.db.prepare("SELECT * FROM asset_upload_cache WHERE asset_id = ? ORDER BY created_at DESC").all(assetId);
    if (!rows.length) return { assetId, uploaded: false, url: "", expiresAt: null, reason: "未上传" };
    const r = rows[0];
    const expired = r.expires_at && r.expires_at < Date.now();
    return { assetId, uploaded: Boolean(r.uploaded) && !expired, url: r.url, expiresAt: r.expires_at || null, expired, reason: expired ? "URL 已过期，需重传" : (r.uploaded ? "已上传" : r.reason) };
  }

  close() { try { this.db.close(); } catch { /* ignore */ } }
}

export default AssetUploader;
