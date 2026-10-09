/* ============================================================================
 * AssetUploader 测试：RemoteURL / DataURI / TOS 诚实 / 哈希缓存去重。
 * 运行：node --test tools-server/director/asset-upload.test.mjs
 * ==========================================================================*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AssetUploader } from "./asset-upload.mjs";

function tmpdb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "upload-test-")), "uploads.db");
}

function tmpAsset(name, bytes) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "upload-file-")), name);
  fs.writeFileSync(f, Buffer.alloc(bytes || 16, 0x41));
  return f;
}

test("remote_url: 直接引用 + 哈希缓存命中（不重复上传）", async () => {
  const u = new AssetUploader({ dbFile: tmpdb() });
  const f = tmpAsset("ref.png", 16);
  const r1 = await u.prepareReference({ assetId: "AST-1", localPath: f, kind: "remote_url", remoteUrl: "https://cdn.example.com/ref.png" });
  assert.equal(r1.uploaded, true);
  assert.equal(r1.type, "remote_url");
  assert.equal(r1.url, "https://cdn.example.com/ref.png");

  const r2 = await u.prepareReference({ assetId: "AST-1", localPath: f, kind: "remote_url", remoteUrl: "https://cdn.example.com/ref.png" });
  assert.equal(r2.cacheHit, true, "相同文件应命中缓存");
  u.close();
});

test("data_uri: 小文件内联；超上限拒绝", async () => {
  const u = new AssetUploader({ dbFile: tmpdb(), maxDataUriBytes: 1024 });
  const small = tmpAsset("small.png", 32);
  const r = await u.prepareReference({ assetId: "AST-2", localPath: small, kind: "data_uri" });
  assert.equal(r.uploaded, true);
  assert.ok(r.url.startsWith("data:image/png;base64,"));

  const big = tmpAsset("big.png", 2048);
  const rb = await u.prepareReference({ assetId: "AST-3", localPath: big, kind: "data_uri" });
  assert.equal(rb.uploaded, false);
  assert.ok(/超过/.test(rb.reason), "超上限应诚实拒绝");
  u.close();
});

test("tos: 无 worker 时诚实返回未配置（不伪造上传）", async () => {
  const u = new AssetUploader({ dbFile: tmpdb() });
  const f = tmpAsset("v.mp4", 16);
  const r = await u.prepareReference({ assetId: "AST-4", localPath: f, kind: "tos" });
  assert.equal(r.uploaded, false);
  assert.ok(/未配置/.test(r.reason));
  u.close();
});

test("status: 反映是否已上传与过期", async () => {
  const u = new AssetUploader({ dbFile: tmpdb() });
  const f = tmpAsset("s.png", 16);
  await u.prepareReference({ assetId: "AST-5", localPath: f, kind: "data_uri" });
  const s = u.status("AST-5");
  assert.equal(s.uploaded, true);
  assert.ok(s.url.startsWith("data:"));
  u.close();
});
