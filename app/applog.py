"""应用动作日志（config.json → log.enabled 开关，默认关闭）。

记录内容：
- [api]       前端 → 后端的每次 /api/ 请求（方法/路径/状态/耗时）
- [llm]       后端 → 模型服务的每次调用（chat/probe，含耗时与结果）
- [metrics]   后端 → vLLM /metrics、Prometheus 快照的拉取
- [test]      测试生命周期（启动/停止/结束/case 状态/错误）
- [analysis]  AI 分析生成过程（开始/模型调用/落盘/失败原因）
- [model]     模型配置增删改、Prometheus 配置保存等管理动作

特性：
- 日志文件：<数据目录>/logs/app.log（1MB × 5 个轮转备份，UTF-8）
- 开关每次写入时从 config.json 读取，修改后即时生效，无需重启
- 日志系统自身故障绝不影响业务（所有异常静默）
"""
import logging
import os
import threading
from logging.handlers import RotatingFileHandler

from . import _paths
from . import model_store

_lock = threading.Lock()
_logger = None


def _get_logger() -> logging.Logger:
    """惰性构建文件 logger（首次写入时创建 logs/ 目录）。"""
    global _logger
    if _logger is None:
        os.makedirs(os.path.join(_paths.data_root(), "logs"), exist_ok=True)
        logger = logging.getLogger("llm_test")
        logger.setLevel(logging.INFO)
        logger.propagate = False
        handler = RotatingFileHandler(
            os.path.join(_paths.data_root(), "logs", "app.log"),
            maxBytes=1024 * 1024, backupCount=5, encoding="utf-8")
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
        logger.addHandler(handler)
        _logger = logger
    return _logger


def log(event: str, detail: str = "") -> None:
    """记录一条动作日志。event 为动作类别（api/llm/test/...），
    detail 为自由文本。开关关闭时无操作。"""
    try:
        if not model_store.get_log_enabled():
            return
        with _lock:
            _get_logger().info(
                f"[{event}] {detail}" if detail else f"[{event}]")
    except Exception:
        pass  # 日志系统自身故障不影响业务
