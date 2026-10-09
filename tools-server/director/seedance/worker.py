#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Harness Director — Seedance (火山方舟 Ark) Python sidecar worker.

通过 stdin/stdout 的 JSON-RPC 与桌面端通信（每行一个 JSON 对象）：
  - stdout 只输出协议 JSON（每行一个对象）；
  - 诊断日志一律写 stderr；
  - 绝不把 API Key 写入 stdout / 日志 / 文件。

调用官方 SDK：from volcenginesdkarkruntime import Ark

支持两种明确隔离的消费通道（billing_mode）：
  - agent_plan : https://ark.cn-beijing.volces.com/api/plan/v3
  - platform   : https://ark.cn-beijing.volces.com/api/v3
Agent Plan 失败时绝不静默切换到 Platform（避免意外账单）。

运行：
  python3 worker.py
环境变量：
  ARK_API_KEY          必填（开发环境读取；正式桌面端由 macOS Keychain 注入）
  ARK_BASE_URL         可选，覆盖默认 base_url（调试用，一般勿设）
"""
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ---- 尽力导入官方 SDK；缺失时给出明确安装指引而不崩 worker ----
try:
    from volcenginesdkarkruntime import Ark  # type: ignore
    SDK_AVAILABLE = True
except Exception as _e:  # pragma: no cover - 环境相关
    Ark = None
    SDK_AVAILABLE = False
    SDK_IMPORT_ERROR = str(_e)

# 两条明确隔离的消费通道（不得自动互切）
BASE_URLS = {
    "agent_plan": "https://ark.cn-beijing.volces.com/api/plan/v3",
    "platform": "https://ark.cn-beijing.volces.com/api/v3",
}

# 结构化参数白名单：只透传这些字段，避免把 CLI 字符串拼进导演提示词
KNOWN_KWARGS = {
    "model", "content", "resolution", "ratio", "duration",
    "generate_audio", "watermark", "return_last_frame", "callback_url",
}

# 能力矩阵（静态声明；billing_mode 兼容性以首次真实调用为准）
CAPABILITIES = {
    "name": "seedance",
    "displayName": "火山方舟 Seedance",
    "textToVideo": True,
    "imageToVideo": True,
    "firstLastFrame": True,
    "referenceImage": True,
    "referenceVideo": True,
    "referenceAudio": True,
    "maxDuration": 12,
    "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    "resolutions": ["480p", "720p", "1080p"],
    "supportsAudio": True,
    "watermark": True,
    "returnLastFrame": True,
    "supportsSeed": False,
    "negativePrompt": False,
    "channels": ["agent_plan", "platform"],
    "sdkAvailable": SDK_AVAILABLE,
    "sdkImportError": None if SDK_AVAILABLE else SDK_IMPORT_ERROR,
}

# ============================================================================
# 按模型族划分的能力矩阵（Python Worker 是能力的单一事实来源，Node 端只缓存）。
# 新模型只需在此追加一个族；未知模型默认失败关闭（不按同一参数集放行）。
# 参数值基于火山方舟 Seedance 公开能力；通道兼容性以服务端实际返回为准。
# ============================================================================
SEEDANCE_MODEL_FAMILIES = {
    "seedance-1.0": {
        "family": "seedance-1.0",
        "channels": ["platform"],  # 真实验证（2026-08）：Agent Plan 对 1.0-pro 返回 UnsupportedModel
        "maxDuration": 12,
        "minDuration": 1,
        "resolutions": ["480p", "720p", "1080p"],
        "ratios": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
        "generateAudio": True,
        "watermark": True,
        "returnLastFrame": True,
        "firstFrame": True,
        "lastFrame": True,
        "referenceImage": True,
        "referenceVideo": False,
        "referenceAudio": True,
        "negativePrompt": False,
        "notes": "Seedance 1.x；结构化参数（resolution/ratio/duration 等），不拼进提示词。",
    },
    "seedance-2.0": {
        "family": "seedance-2.0",
        "maxDuration": 12,
        "minDuration": 1,
        "resolutions": ["480p", "720p", "1080p"],
        "ratios": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
        "generateAudio": True,
        "watermark": True,
        "returnLastFrame": True,
        "firstFrame": True,
        "lastFrame": True,
        "referenceImage": True,
        "referenceVideo": False,
        "referenceAudio": True,
        "negativePrompt": False,
        "notes": "Seedance 2.0；同上结构化参数集。",
    },
    "seedance-2.0-fast": {
        "family": "seedance-2.0-fast",
        "maxDuration": 12,
        "minDuration": 1,
        "resolutions": ["480p", "720p", "1080p"],
        "ratios": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
        "generateAudio": True,
        "watermark": True,
        "returnLastFrame": True,
        "firstFrame": True,
        "lastFrame": True,
        "referenceImage": True,
        "referenceVideo": False,
        "referenceAudio": True,
        "negativePrompt": False,
        "notes": "Seedance 2.0 fast；更低时延，参数集同上。",
    },
}

# 家族识别规则：按 model ID 子串匹配（可扩展，新模型在此追加规则）
FAMILY_RULES = [
    ("seedance-2-0-fast", "seedance-2.0-fast"),
    ("seedance-2.0-fast", "seedance-2.0-fast"),
    ("seedance-2", "seedance-2.0"),
    ("seedance-1", "seedance-1.0"),
    ("seedance-0", "seedance-1.0"),  # seedance-1-0-* 的兼容写法
]


def detect_model_family(model_id):
    """返回模型族名；未知模型返回 None（失败关闭）。"""
    m = str(model_id or "").lower()
    if not m:
        return None
    for needle, family in FAMILY_RULES:
        if needle in m:
            return family
    return None


def capabilities_for(model_id):
    """按模型 ID 返回该模型族能力；未知模型返回 None（不按同一参数集放行）。"""
    family = detect_model_family(model_id)
    if not family:
        return None
    return SEEDANCE_MODEL_FAMILIES.get(family)


def validate_spec(spec):
    """校验 Generation Spec 参数是否被该模型族支持。

    返回 {ok, errors[], warnings[], capabilities}。
    errors = 阻断（绝不创建远程任务）；warnings = 提示（不阻断）。
    """
    errors = []
    warnings = []
    model = str(spec.get("model") or "")
    caps = capabilities_for(model)
    if not caps:
        return {
            "ok": False,
            "errors": [
                {"param": "model", "message": "未收录模型能力：%s" % (model or "(空)"),
                 "supported": sorted(SEEDANCE_MODEL_FAMILIES.keys()),
                 "fix": "请配置已收录的 Seedance 模型 ID（1.x / 2.0 / 2.0-fast），或在 SEEDANCE_MODEL_FAMILIES 中登记该模型族"}
            ],
            "warnings": [],
            "capabilities": None,
        }

    # resolution
    res = str(spec.get("resolution") or "")
    if res and res not in caps["resolutions"]:
        errors.append({"param": "resolution", "message": "分辨率 %s 不支持" % res,
                       "supported": caps["resolutions"],
                       "fix": "改为 " + " / ".join(caps["resolutions"])})
    # ratio
    ratio = str(spec.get("ratio") or "")
    if ratio and ratio not in caps["ratios"]:
        errors.append({"param": "ratio", "message": "画幅 %s 不支持" % ratio,
                       "supported": caps["ratios"],
                       "fix": "改为 " + " / ".join(caps["ratios"])})
    # duration
    dur = spec.get("duration")
    if dur is not None:
        try:
            d = float(dur)
            if d < caps["minDuration"] or d > caps["maxDuration"]:
                errors.append({"param": "duration", "message": "时长 %ss 超出范围" % d,
                               "supported": "%s-%s 秒" % (caps["minDuration"], caps["maxDuration"]),
                               "fix": "改为 %s-%s 秒" % (caps["minDuration"], caps["maxDuration"])})
        except (TypeError, ValueError):
            errors.append({"param": "duration", "message": "时长不是数字", "supported": "数字（秒）", "fix": "改为秒数"})
    # 特性开关
    for key, label in (("generate_audio", "生成音频"), ("watermark", "水印"), ("return_last_frame", "返回尾帧")):
        if bool(spec.get(key)) and not caps[key]:
            errors.append({"param": key, "message": "%s 不被该模型支持" % label,
                           "supported": "否", "fix": "关闭 %s" % key})
    # 参考素材
    refs = spec.get("references") or {}
    if refs.get("first_frame_url") and not caps["firstFrame"]:
        errors.append({"param": "references.first_frame_url", "message": "首帧图生视频不被该模型支持",
                       "supported": "否", "fix": "移除首帧参考或更换模型"})
    if refs.get("last_frame_url") and not caps["lastFrame"]:
        errors.append({"param": "references.last_frame_url", "message": "尾帧不被该模型支持",
                       "supported": "否", "fix": "移除尾帧参考或更换模型"})
    for u in refs.get("reference_video_urls") or []:
        if u and not caps["referenceVideo"]:
            errors.append({"param": "references.reference_video_urls", "message": "参考视频不被该模型支持",
                           "supported": "否", "fix": "移除参考视频或更换模型"})
    if caps.get("notes"):
        warnings.append({"param": "model", "message": caps["notes"]})
    # 通道兼容性（真实验证结论）：Agent Plan 不支持时提前 warning，绝不静默切到 Platform
    allowed = caps.get("channels")
    billing = str(spec.get("billing_mode") or "")
    if allowed and billing and billing not in allowed:
        warnings.append({"param": "billing_mode", "message": "模型族 %s 暂不支持 %s 通道（以服务端为准），请改用 %s；服务端兼容性错误不会被自动切换" % (caps["family"], billing, " / ".join(allowed))})

    return {"ok": len(errors) == 0, "errors": errors, "warnings": warnings,
            "capabilities": {"family": caps["family"], "maxDuration": caps["maxDuration"],
                             "minDuration": caps["minDuration"], "resolutions": caps["resolutions"],
                             "ratios": caps["ratios"], "generateAudio": caps["generateAudio"],
                             "watermark": caps["watermark"], "returnLastFrame": caps["returnLastFrame"],
                             "firstFrame": caps["firstFrame"], "lastFrame": caps["lastFrame"],
                             "referenceImage": caps["referenceImage"], "referenceVideo": caps["referenceVideo"],
                             "referenceAudio": caps["referenceAudio"]}}


def _redact(text):
    """脱敏：隐藏 API Key / token 样式的敏感串。"""
    if not isinstance(text, str):
        return text
    key = os.environ.get("ARK_API_KEY", "")
    if key and len(key) > 6:
        text = text.replace(key, "***")
    return text


def log(*parts):
    try:
        sys.stderr.write(" ".join(_redact(str(p)) for p in parts) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _client_for(spec):
    """按 billing_mode 构建客户端；绝不跨通道回退。"""
    billing = str(spec.get("billing_mode") or "agent_plan")
    base_url = spec.get("base_url") or BASE_URLS.get(billing)
    if not base_url:
        base_url = BASE_URLS.get(billing)
    api_key = os.environ.get("ARK_API_KEY", "")
    if not api_key:
        raise RuntimeError("缺少 ARK_API_KEY：开发环境请 export ARK_API_KEY；正式桌面端请先写入 macOS Keychain")
    return Ark(base_url=base_url, api_key=api_key), base_url


def _build_content(spec):
    """优先使用 spec.content；否则由 prompt + reference 结构化构造。

    content 为结构化字段（text / image_url / video_url / audio_url / first_frame /
    last_frame / reference_image_urls），绝不把 resolution/duration 等 CLI 参数
    拼进导演提示词。
    """
    content = spec.get("content")
    if isinstance(content, list) and content:
        return content
    items = []
    prompt = str(spec.get("prompt") or "").strip()
    if prompt:
        items.append({"type": "text", "text": prompt})
    # 结构化参考素材（已上传为远程 URL，见 AssetUploader）
    refs = spec.get("references") or {}
    if refs.get("first_frame_url"):
        items.append({"type": "image_url", "image_url": {"url": refs["first_frame_url"]}})
    if refs.get("last_frame_url"):
        items.append({"type": "image_url", "image_url": {"url": refs["last_frame_url"]}})
    for u in refs.get("reference_image_urls") or []:
        items.append({"type": "image_url", "image_url": {"url": u}})
    for u in refs.get("reference_video_urls") or []:
        items.append({"type": "video_url", "video_url": {"url": u}})
    for u in refs.get("reference_audio_urls") or []:
        items.append({"type": "audio_url", "audio_url": {"url": u}})
    if not items:
        raise ValueError("Generation Spec 缺少 content 且无 prompt")
    return items


def _build_kwargs(spec):
    kwargs = {"model": str(spec.get("model") or "")}
    if not kwargs["model"]:
        raise ValueError("Generation Spec 缺少 model（模型 ID 不得写死，由设置页配置）")
    kwargs["content"] = _build_content(spec)

    # 结构化参数（不使用 CLI 字符串拼接）
    for key in ("resolution", "ratio", "duration"):
        if spec.get(key) is not None and spec.get(key) != "":
            kwargs[key] = spec[key]
    for key in ("generate_audio", "watermark", "return_last_frame"):
        if key in spec:
            kwargs[key] = bool(spec[key])

    # 其它模型支持的参数（extra），透传但只允许白名单外的安全键，避免注入危险参数
    extra = spec.get("extra") or {}
    if isinstance(extra, dict):
        for k, v in extra.items():
            if k in KNOWN_KWARGS:
                continue
            if not str(k).isidentifier():
                raise ValueError("非法扩展参数名：" + str(k))
            kwargs[k] = v
    return kwargs


def _tos_upload(local_path, mime):
    """上传本地素材到 TOS。

    优先使用运行时注入的「预签名 URL」或「临时凭证」，不在桌面端保存长期 AK/SK：
      - TOS_PRESIGNED_URL：直接 PUT 到该预签名 URL；
      - TOS_ACCESS_KEY + TOS_SECRET_KEY + TOS_SECURITY_TOKEN + TOS_ENDPOINT + TOS_BUCKET：
        使用临时凭证生成预签名 URL（若安装了 tos 或 volcengine SDK）。
    两者都缺时诚实返回「未配置」，绝不伪造上传。
    """
    presigned = os.environ.get("TOS_PRESIGNED_URL")
    if presigned:
        try:
            with open(local_path, "rb") as f:
                data = f.read()
            req = urllib.request.Request(presigned, data=data, method="PUT", headers={"Content-Type": mime or "application/octet-stream"})
            with urllib.request.urlopen(req, timeout=600) as resp:
                resp.read()
            # 预签名 URL 通常即下载 URL（或同源），expiry 由服务端决定，本地不可知
            return {"ok": True, "url": presigned, "expiresAt": None, "reason": "预签名 URL PUT 上传成功"}
        except Exception as e:
            return {"ok": False, "reason": "TOS 预签名上传失败：" + _redact(str(e))}

    ak = os.environ.get("TOS_ACCESS_KEY")
    sk = os.environ.get("TOS_SECRET_KEY")
    token = os.environ.get("TOS_SECURITY_TOKEN")
    endpoint = os.environ.get("TOS_ENDPOINT")
    bucket = os.environ.get("TOS_BUCKET")
    if ak and sk and token and endpoint and bucket:
        try:
            import tos  # type: ignore
        except Exception:
            return {"ok": False, "reason": "已配置临时凭证但未安装 TOS SDK（pip install tos）"}
        try:
            # 最小权限：临时凭证 + 仅对象上传/读取
            client = tos.TosClientV2(ak, sk, endpoint, region=os.environ.get("TOS_REGION", "cn-beijing"), security_token=token)
            key = "director-uploads/" + hashlib.sha256(open(local_path, "rb").read()).hexdigest() + os.path.splitext(local_path)[1]
            with open(local_path, "rb") as f:
                client.put_object(bucket, key, f)
            url = endpoint.rstrip("/") + "/" + bucket + "/" + key
            return {"ok": True, "url": url, "expiresAt": None, "reason": "临时凭证上传成功"}
        except Exception as e:
            return {"ok": False, "reason": "TOS 临时凭证上传失败：" + _redact(str(e))}

    return {"ok": False, "reason": "TOS 未配置：请注入 TOS_PRESIGNED_URL 或临时凭证（TOS_ACCESS_KEY/TOS_SECRET_KEY/TOS_SECURITY_TOKEN/TOS_ENDPOINT/TOS_BUCKET）；长期 AK/SK 不入桌面端"}


def _extract_result_url(task):
    """从真实 Seedance task 结构抽取视频 URL。

    实测结构（Seedance 1.0，2026-08）：
      content: {"video_url": "https://...mp4?...", "last_frame_url": null, "file_url": null}
    同时兼容历史上 content 为 list[item] 的形态。
    """
    content = task.get("content")
    if isinstance(content, dict):
        vu = content.get("video_url")
        if isinstance(vu, str) and vu:
            return vu
        if isinstance(vu, dict) and vu.get("url"):
            return vu["url"]
        if isinstance(content.get("file_url"), str) and content["file_url"]:
            return content["file_url"]
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            vu = item.get("video_url")
            if isinstance(vu, dict) and vu.get("url"):
                return vu["url"]
            if isinstance(vu, str) and vu:
                return vu
            if item.get("type") == "video_url" and isinstance(item.get("url"), str):
                return item["url"]
    # 兼容直接字段
    for k in ("video_url", "url", "output_url"):
        if task.get(k):
            return task[k]
    return None


def _download(url, target_path, timeout=600):
    """下载远程视频到本地；校验 Content-Type 与大小，并做路径边界（由 Node 侧传入目标）。"""
    os.makedirs(os.path.dirname(target_path) or ".", exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "harness-director/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        ctype = resp.headers.get("Content-Type", "")
        length = resp.headers.get("Content-Length")
        size = 0
        tmp = target_path + ".part"
        with open(tmp, "wb") as f:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                size += len(chunk)
                if size > 2 * 1024 * 1024 * 1024:  # 2GB 硬上限
                    raise RuntimeError("下载体积超上限")
        os.replace(tmp, target_path)
    return {
        "path": target_path,
        "bytes": size,
        "sha256": _sha256_file(target_path),
        "content_type": ctype,
        "content_length": length,
    }


class SeedanceProvider:
    """统一 Provider 接口的 Seedance 实现。"""

    def create_task(self, spec):
        client, base_url = _client_for(spec)
        kwargs = _build_kwargs(spec)
        result = client.content_generation.tasks.create(**kwargs)
        # 兼容 dict / object 两种返回
        data = result if isinstance(result, dict) else getattr(result, "model_dump", lambda: None)()
        if data is None:
            data = result if isinstance(result, dict) else {"id": getattr(result, "id", None)}
        return {
            "ok": True,
            "task_id": data.get("id") or data.get("task_id"),
            "base_url": base_url,
            "billing_mode": spec.get("billing_mode"),
            "model": spec.get("model"),
            "status": data.get("status", "queued"),
            "raw": data,
        }

    def get_task(self, spec, task_id):
        client, _ = _client_for(spec)
        result = client.content_generation.tasks.get(task_id=task_id)
        data = result if isinstance(result, dict) else getattr(result, "model_dump", lambda: None)()
        if data is None:
            data = result if isinstance(result, dict) else {"id": getattr(result, "id", None)}
        return {"ok": True, "task_id": task_id, "status": data.get("status"), "raw": data}

    def list_tasks(self, spec, filters=None):
        client, _ = _client_for(spec)
        result = client.content_generation.tasks.list(**(filters or {}))
        data = result if isinstance(result, dict) else getattr(result, "model_dump", lambda: None)()
        if data is None:
            data = result if isinstance(result, dict) else {"data": []}
        return {"ok": True, "tasks": data.get("data") or data.get("tasks") or []}

    def cancel_or_delete_task(self, spec, task_id):
        client, _ = _client_for(spec)
        try:
            client.content_generation.tasks.delete(task_id=task_id)
            return {"ok": True, "task_id": task_id, "action": "delete"}
        except Exception as e:  # 某些模型只支持取消
            return {"ok": False, "task_id": task_id, "action": "delete", "error": _redact(str(e))}

    def download_result(self, spec, task_id, target_path):
        got = self.get_task(spec, task_id)
        url = _extract_result_url(got.get("raw") or {})
        if not url:
            return {"ok": False, "task_id": task_id, "error_kind": "download", "error": "任务结果无视频 URL"}
        info = _download(url, target_path)
        return {"ok": True, "task_id": task_id, **info}


_provider = SeedanceProvider()


def handle(req):
    method = req.get("method")
    params = req.get("params") or {}
    rid = req.get("id")

    if method == "ping":
        return {"ok": True, "sdkAvailable": SDK_AVAILABLE, "sdkImportError": None if SDK_AVAILABLE else SDK_IMPORT_ERROR}

    if method == "env_status":
        # 只返回布尔值，绝不返回 Key 本体（供诊断「凭证是否已注入 worker」）
        return {
            "ok": True,
            "has_ark_api_key": bool(os.environ.get("ARK_API_KEY")),
            "has_tos_credentials": bool(os.environ.get("TOS_PRESIGNED_URL") or (os.environ.get("TOS_ACCESS_KEY") and os.environ.get("TOS_SECRET_KEY"))),
            "billing_mode_env": os.environ.get("SEEDANCE_BILLING_MODE") or "",
            "model_env": os.environ.get("SEEDANCE_MODEL") or "",
        }

    if method == "capabilities":
        return {"ok": True, **CAPABILITIES}

    if method == "get_capabilities":
        # 按模型族返回能力（Node 端缓存此结果，能力定义以本 worker 为准）
        model = str(params.get("model") or "")
        caps = capabilities_for(model) if model else None
        if model and not caps:
            return {"ok": False, "error_kind": "validation",
                    "error": "未收录模型能力：" + model,
                    "supportedModels": sorted(SEEDANCE_MODEL_FAMILIES.keys())}
        return {"ok": True, "model": model, "family": caps["family"] if caps else None,
                "capabilities": None if not caps else {
                    "family": caps["family"], "maxDuration": caps["maxDuration"],
                    "minDuration": caps["minDuration"], "resolutions": caps["resolutions"],
                    "ratios": caps["ratios"], "generateAudio": caps["generateAudio"],
                    "watermark": caps["watermark"], "returnLastFrame": caps["returnLastFrame"],
                    "firstFrame": caps["firstFrame"], "lastFrame": caps["lastFrame"],
                    "referenceImage": caps["referenceImage"], "referenceVideo": caps["referenceVideo"],
                    "referenceAudio": caps["referenceAudio"]},
                "families": sorted(SEEDANCE_MODEL_FAMILIES.keys())}

    if method == "validate_generation_request":
        # 能力校验的正式入口（不创建远程任务）
        return validate_spec(params.get("spec") or {})

    if method == "tos_upload":
        # TOS 上传独立于 Ark SDK，先于 SDK 可用性闸门处理
        try:
            return _tos_upload(params.get("local_path") or "", params.get("mime") or "")
        except Exception as e:
            return {"ok": False, "reason": "TOS 上传异常：" + _redact(str(e))}

    if not SDK_AVAILABLE:
        return {"ok": False, "error_kind": "validation",
                "error": "volcengine-python-sdk[ark] 未安装。请运行：python3 -m pip install --upgrade \"volcengine-python-sdk[ark]\""}

    spec = params.get("spec") or {}

    try:
        if method == "create_task":
            # 防御纵深：创建远程任务前再次校验（阻断错误绝不发请求）
            v = validate_spec(spec)
            if not v["ok"]:
                return {"ok": False, "error_kind": "validation",
                        "error": "生成请求未通过能力校验", "validation": v}
            return _provider.create_task(spec)
        if method == "get_task":
            return _provider.get_task(spec, params.get("task_id"))
        if method == "list_tasks":
            return _provider.list_tasks(spec, params.get("filters"))
        if method == "cancel_or_delete_task":
            return _provider.cancel_or_delete_task(spec, params.get("task_id"))
        if method == "download_result":
            return _provider.download_result(spec, params.get("task_id"), params.get("target_path"))
        return {"ok": False, "error_kind": "validation", "error": "未知方法：" + str(method)}
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = _redact(e.read().decode("utf-8", "replace"))[:500]
        except Exception:
            pass
        return {"ok": False, "error_kind": "provider", "http_status": e.code, "error": body or str(e)}
    except Exception as e:
        msg = _redact(str(e))
        # Agent Plan 不兼容等套餐/模型兼容性问题：原样上报，绝不切换到 Platform
        return {"ok": False, "error_kind": "provider", "error": msg}


def main():
    log("[seedance-worker] start pid=%s sdk=%s", os.getpid(), SDK_AVAILABLE)
    if not SDK_AVAILABLE:
        log("[seedance-worker] WARNING sdk import error: %s", SDK_IMPORT_ERROR)
    stdin = sys.stdin
    out = sys.stdout
    for line in stdin:
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
        except Exception as e:  # 兜底：绝不因异常破坏协议
            resp = {"ok": False, "error_kind": "internal", "error": _redact(str(e))}
        resp["id"] = rid
        try:
            out.write(json.dumps(resp, ensure_ascii=False) + "\n")
            out.flush()
        except Exception:
            break
    log("[seedance-worker] exit")


if __name__ == "__main__":
    main()
