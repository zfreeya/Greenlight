#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Mock Seedance worker：供离线测试 SeedanceWorkerProvider 的完整生命周期。

与真实 worker.py 使用相同的 JSON-RPC 协议，但不调用任何 SDK / 网络。
用 spec.model 决定行为：
  - 含 "mock-success" ：create → running → succeeded（可下载）
  - 含 "mock-fail"    ：create → running → failed
  - 含 "mock-cancel"  ：create → running → cancelled
  - 含 "mock-hang"    ：create_task 之后 get_task 永不返回（测超时）
"""
import hashlib
import json
import sys
import time

_state = {}  # task_id -> {"status": ..., "polls": ...}


def log(*a):
    sys.stderr.write(" ".join(str(x) for x in a) + "\n")


def _sha256(b):
    return hashlib.sha256(b).hexdigest()


def handle(req):
    m = req.get("method")
    p = req.get("params") or {}
    spec = p.get("spec") or {}
    model = str(spec.get("model") or "")
    tid = p.get("task_id") or _state.get("last_task_id")

    if m == "ping":
        return {"ok": True, "sdkAvailable": True}
    if m == "capabilities":
        return {"ok": True, "name": "seedance", "textToVideo": True, "imageToVideo": True,
                "firstLastFrame": True, "referenceImage": True, "referenceVideo": True,
                "referenceAudio": True, "maxDuration": 12, "aspectRatios": ["16:9", "9:16", "1:1"],
                "resolutions": ["1080p"], "supportsAudio": True, "watermark": True,
                "returnLastFrame": True, "supportsSeed": False, "negativePrompt": False,
                "channels": ["agent_plan", "platform"], "sdkAvailable": True}
    if m == "get_capabilities":
        # mock：模拟模型族能力（与真实 worker 同构）
        m_model = str(p.get("model") or model or "")
        fam = "seedance-1.0"
        if "2-0-fast" in m_model:
            fam = "seedance-2.0-fast"
        elif "2" in m_model:
            fam = "seedance-2.0"
        caps = {"family": fam, "maxDuration": 12, "minDuration": 1,
                "resolutions": ["480p", "720p", "1080p"], "ratios": ["16:9", "9:16", "1:1"],
                "generateAudio": True, "watermark": True, "returnLastFrame": True,
                "firstFrame": True, "lastFrame": True, "referenceImage": True,
                "referenceVideo": False, "referenceAudio": True}
        return {"ok": True, "model": m_model, "family": fam, "capabilities": caps,
                "families": ["seedance-1.0", "seedance-2.0", "seedance-2.0-fast"]}
    if m == "validate_generation_request":
        errors = []
        warnings = []
        res = str(spec.get("resolution") or "")
        if res and res not in ["480p", "720p", "1080p"]:
            errors.append({"param": "resolution", "message": "分辨率 %s 不支持" % res,
                           "supported": ["480p", "720p", "1080p"], "fix": "改为 480p/720p/1080p"})
        dur = spec.get("duration")
        if dur is not None and float(dur) > 12:
            errors.append({"param": "duration", "message": "时长超出上限", "supported": "1-12 秒", "fix": "改为 ≤12 秒"})
        if not spec.get("model"):
            errors.append({"param": "model", "message": "未配置模型", "supported": ["seedance-1.0"], "fix": "配置模型"})
        return {"ok": len(errors) == 0, "errors": errors, "warnings": warnings, "capabilities": None}
    if m == "env_status":
        return {"ok": True, "has_ark_api_key": False}
    if m == "create_task":
        new_tid = "mock-" + str(int(time.time() * 1000))
        _state["last_task_id"] = new_tid
        _state[new_tid] = {"status": "queued", "polls": 0}
        return {"ok": True, "task_id": new_tid, "status": "queued", "raw": {"id": new_tid, "status": "queued"}}
    if m == "get_task":
        if "mock-hang" in model:
            time.sleep(3600)  # 永不返回（测超时）
        if tid not in _state:
            return {"ok": True, "task_id": tid, "status": "succeeded", "raw": {"id": tid, "status": "succeeded"}}
        st = _state[tid]
        st["polls"] += 1
        if "mock-fail" in model:
            st["status"] = "failed" if st["polls"] >= 2 else "running"
        elif "mock-cancel" in model:
            st["status"] = "cancelled" if st["polls"] >= 2 else "running"
        else:
            st["status"] = "succeeded" if st["polls"] >= 2 else "running"
        raw = {"id": tid, "status": st["status"]}
        if st["status"] == "succeeded":
            raw["content"] = [{"type": "video_url", "video_url": {"url": "https://example.invalid/mock.mp4"}}]
        return {"ok": True, "task_id": tid, "status": st["status"], "raw": raw}
    if m == "list_tasks":
        return {"ok": True, "tasks": []}
    if m == "cancel_or_delete_task":
        if tid in _state:
            _state[tid]["status"] = "cancelled"
        return {"ok": True, "task_id": tid, "action": "delete"}
    if m == "download_result":
        target = p.get("target_path") or "/tmp/mock-out.mp4"
        data = b"FAKEMP4" * 100
        with open(target, "wb") as f:
            f.write(data)
        return {"ok": True, "task_id": tid, "path": target, "bytes": len(data),
                "sha256": _sha256(data), "content_type": "video/mp4"}
    if m == "tos_upload":
        return {"ok": False, "reason": "mock：TOS 未配置"}
    return {"ok": False, "error": "unknown method " + str(m)}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        try:
            resp = handle(req)
        except Exception as e:
            resp = {"ok": False, "error": str(e)}
        resp["id"] = rid
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
