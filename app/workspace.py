"""测试任务持久化。

workspace/<任务名>/ 目录下保存：
  - config.json  测试启动时的配置（profile、模型快照、开始时间）
  - result.json  测试结束（完成/停止/出错）后的完整结果
"""
import json
import os
import re
import time

from . import _paths

WORKSPACE_DIR = os.path.join(_paths.data_root(), "workspace")

# 任务名合法字符：中文/字母/数字/连字符（防路径穿越）
_NAME_RE = re.compile(r"^[\w\u4e00-\u9fff\-]+$")


def _task_dir(task_name: str) -> str:
    return os.path.join(WORKSPACE_DIR, task_name)


def valid_name(task_name: str) -> bool:
    return bool(task_name) and bool(_NAME_RE.match(task_name)) and ".." not in task_name


def new_task_name(kind: str) -> str:
    """生成任务名：<类型>-<时间戳>（如 文本测试-202608261355）。

    同一分钟内多次启动时追加序号避免目录重名。
    """
    os.makedirs(WORKSPACE_DIR, exist_ok=True)
    base = f"{kind}-{time.strftime('%Y%m%d%H%M')}"
    name = base
    seq = 2
    while os.path.exists(_task_dir(name)):
        name = f"{base}-{seq}"
        seq += 1
    return name


def save_config(task_name: str, config: dict) -> None:
    d = _task_dir(task_name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "config.json"), "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)


def save_result(task_name: str, result: dict) -> None:
    d = _task_dir(task_name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "result.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    # 同步更新 config 中的状态（历史列表从 config 读取，避免停留在 running）
    cfg_path = os.path.join(d, "config.json")
    if os.path.isfile(cfg_path):
        try:
            with open(cfg_path, encoding="utf-8") as f:
                cfg = json.load(f)
            cfg["status"] = result.get("status", "")
            with open(cfg_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
        except (OSError, ValueError):
            pass


def list_history(kind: str) -> list:
    """列出某类型的全部历史任务，按开始时间倒序。"""
    if not os.path.isdir(WORKSPACE_DIR):
        return []
    items = []
    prefix = kind + "-"
    for name in os.listdir(WORKSPACE_DIR):
        cfg_path = os.path.join(_task_dir(name), "config.json")
        if not name.startswith(prefix) or not os.path.isfile(cfg_path):
            continue
        try:
            with open(cfg_path, encoding="utf-8") as f:
                cfg = json.load(f)
        except (OSError, ValueError):
            continue
        has_result = os.path.isfile(os.path.join(_task_dir(name), "result.json"))
        items.append({
            "name": name,
            "kind": kind,
            "started_at": cfg.get("started_at", 0),
            "status": cfg.get("status", ""),
            "has_result": has_result,
            "params": cfg.get("params", {}),
        })
    items.sort(key=lambda x: x["started_at"], reverse=True)
    return items


def load_task(task_name: str):
    """读取某任务的 config 与 result（result 不存在时为空 dict）。"""
    if not valid_name(task_name):
        return None
    cfg_path = os.path.join(_task_dir(task_name), "config.json")
    if not os.path.isfile(cfg_path):
        return None
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)
    result = {}
    res_path = os.path.join(_task_dir(task_name), "result.json")
    if os.path.isfile(res_path):
        try:
            with open(res_path, encoding="utf-8") as f:
                result = json.load(f)
        except (OSError, ValueError):
            result = {}
    return {"config": cfg, "result": result}
