"""模型配置持久化存储模块。

配置保存到本地 config.json，API Key 以 base64 编码存储。
"""
import base64
import json
import os
import uuid
from threading import Lock
from typing import Optional

from . import _paths

CONFIG_FILE = os.path.join(_paths.data_root(), "config.json")

_lock = Lock()


def _load_all() -> dict:
    if not os.path.exists(CONFIG_FILE):
        return {"models": []}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {"models": []}
        # models 缺失/类型不对时仅归一化该键，保留 server/prometheus 等其他配置节
        if not isinstance(data.get("models"), list):
            data["models"] = []
        return data
    except (json.JSONDecodeError, OSError):
        return {"models": []}


def _save_all(data: dict) -> None:
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def encode_key(api_key: str) -> str:
    return base64.b64encode(api_key.encode("utf-8")).decode("utf-8")


def decode_key(encoded: str) -> str:
    try:
        return base64.b64decode(encoded.encode("utf-8")).decode("utf-8")
    except Exception:
        return ""


def list_models() -> list:
    """返回模型列表（不含原始 api_key，仅 has_api_key 布尔值）。"""
    with _lock:
        data = _load_all()
    result = []
    for m in data["models"]:
        result.append({
            "id": m["id"],
            "name": m["name"],
            "model": m["model"],
            "url": m["url"],
            "api_key": "",
            "has_api_key": bool(m.get("api_key")),
        })
    return result


def get_model(model_id: str) -> Optional[dict]:
    with _lock:
        data = _load_all()
    for m in data["models"]:
        if m["id"] == model_id:
            return dict(m)
    return None


def get_model_apikey(model_id: str) -> Optional[str]:
    m = get_model(model_id)
    if m is None:
        return None
    return decode_key(m.get("api_key", ""))


def add_model(name: str, model: str, url: str, api_key: str) -> dict:
    entry = {
        "id": uuid.uuid4().hex[:8],
        "name": name,
        "model": model,
        "url": url,
        "api_key": encode_key(api_key) if api_key else "",
    }
    with _lock:
        data = _load_all()
        data["models"].append(entry)
        _save_all(data)
    return {
        "id": entry["id"],
        "name": entry["name"],
        "model": entry["model"],
        "url": entry["url"],
        "api_key": "",
        "has_api_key": bool(entry["api_key"]),
    }


def update_model(model_id: str, name: str = None, model: str = None,
                 url: str = None, api_key: Optional[str] = None) -> Optional[dict]:
    """更新模型配置。api_key 为 None 表示不变，为空串表示清除，非空表示更新。"""
    with _lock:
        data = _load_all()
        for m in data["models"]:
            if m["id"] == model_id:
                if name is not None and name:
                    m["name"] = name
                if model is not None and model:
                    m["model"] = model
                if url is not None and url:
                    m["url"] = url
                if api_key is not None:
                    m["api_key"] = encode_key(api_key) if api_key else ""
                _save_all(data)
                return {
                    "id": m["id"],
                    "name": m["name"],
                    "model": m["model"],
                    "url": m["url"],
                    "api_key": "",
                    "has_api_key": bool(m["api_key"]),
                }
    return None


def delete_model(model_id: str) -> bool:
    with _lock:
        data = _load_all()
        before = len(data["models"])
        data["models"] = [m for m in data["models"] if m["id"] != model_id]
        if len(data["models"]) == before:
            return False
        _save_all(data)
    return True


# ==================== 服务配置 ====================

DEFAULT_SERVER_PORT = 5888


def get_server_port() -> int:
    """读取服务监听端口（config.json → server.port）。
    配置缺失、类型非法或超出范围时回退默认端口，不抛异常。"""
    with _lock:
        data = _load_all()
    port = (data.get("server") or {}).get("port", DEFAULT_SERVER_PORT)
    if isinstance(port, bool):  # bool 是 int 子类，需排除
        return DEFAULT_SERVER_PORT
    try:
        port = int(port)
    except (TypeError, ValueError):
        return DEFAULT_SERVER_PORT
    if 1 <= port <= 65535:
        return port
    return DEFAULT_SERVER_PORT


# ==================== 日志开关 ====================

def get_log_enabled() -> bool:
    """读取日志开关（config.json → log.enabled，默认关闭）。

    每次调用都从磁盘读取，修改 config.json 后即时生效，无需重启。
    """
    with _lock:
        data = _load_all()
    return bool((data.get("log") or {}).get("enabled", False))


# ==================== Prometheus 配置 ====================

def get_prometheus_config() -> dict:
    """读取 Prometheus 配置（无配置时返回空 dict）。"""
    with _lock:
        return dict(_load_all().get("prometheus", {}))


def save_prometheus_config(url: str, grafana_url: str = "") -> dict:
    """保存 Prometheus 配置（与 models 键并存于同一 config.json）。"""
    with _lock:
        data = _load_all()
        data["prometheus"] = {
            "url": url.strip(),
            "grafana_url": (grafana_url or "").strip(),
        }
        _save_all(data)
        return dict(data["prometheus"])
