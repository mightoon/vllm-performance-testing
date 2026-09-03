"""测试结果 AI 分析：测试结束后把 profile 与指标摘要交给被测模型，
生成 500 字以内的结论并持久化到任务目录（analysis.json）。

调用发生在测试结束之后（_wait_all 后台任务），不影响测试过程数据；
报告模式读取持久化结果，历史任务可随时回看。手动重新分析
（POST API）复用同一入口，输入全部来自磁盘数据，与引擎内存无关。
"""
import asyncio
import json
import os
import time

from . import model_store
from . import applog
from . import prom_snapshot
from . import workspace
from .llm_client import chat_completion

# 500 字中文结论的 token 上限（留足余量防截断）
_MAX_TOKENS = 1500
_TIMEOUT = 180.0

# 正在生成中的任务注册表（进程内）：报告页据此显示"生成中"并轮询，
# 生成完成/失败（analysis.json 落盘）或进程重启后不再 pending
_PENDING = set()


def is_pending(task_name: str) -> bool:
    return task_name in _PENDING

# 输入长度档位 → 可读描述（与前端 lenLabels 口径一致）
_LENGTH_LABELS = {
    "tiny": "极短（~10 token）",
    "short": "短（~100 token）",
    "medium": "中（~1k token）",
    "long": "长（~8k token）",
    "xlong": "超长（~16k token）",
}


def _collect_summary(task: dict, task_name: str) -> dict:
    """从任务数据汇总分析输入：config（profile）+ result（vLLM 指标）
    + metrics.json（Prometheus 统计，无快照时为空）。"""
    cfg, result = task["config"], task["result"]
    p = cfg.get("params", {})
    probe = cfg.get("model_probe") or {}
    rs = result.get("summary") or {}
    profile = {
        "model": p.get("model_name") or (cfg.get("model") or {}).get("name"),
        "vllm_version": probe.get("version"),
        "max_model_len": probe.get("max_model_len"),
        "kv_cache_tokens": probe.get("kv_cache_tokens"),
        "output_tokens_per_request": p.get("article_length"),
        "concurrency": p.get("concurrency"),
    }
    if cfg.get("kind") == "图形测试":
        # 图形测试：输入为图片（多模态），无输入长度档位
        profile.update({
            "test_type": "图形测试（图片理解 + 文章生成）",
            "image_dir": p.get("image_dir"),
            "images_in_dir": p.get("image_pool_size"),
            "images_per_thread": p.get("image_count"),
            # 每请求实测平均输入 token（图片 token 由服务端统计；
            # usage 不可用时为 metrics 差分估算，见 image_engine）
            "prompt_tokens_avg": rs.get("prompt_tokens_avg"),
        })
    else:
        profile.update({
            "test_type": "文本测试",
            "input_length": _LENGTH_LABELS.get(
                p.get("input_length"), p.get("input_length")),
            "iterations_per_thread": p.get("noun_count"),
        })
    return {
        "profile": profile,
        "test": {
            "status": result.get("status") or cfg.get("status"),
            "duration_s": result.get("elapsed"),
            "total_requests": rs.get("total_calls"),
            "total_errors": rs.get("total_errors"),
        },
        # vLLM 服务端指标（引擎整轮统计，见 test_engine._vllm_metrics_summary）
        "vllm_metrics": result.get("vllm_metrics_summary") or {},
        # Prometheus 快照统计（无快照/未配置时为空 dict）
        "prometheus_stats": (prom_snapshot.load_metrics(task_name)
                             or {}).get("stats") or {},
    }


def build_prompt(summary: dict) -> str:
    """构造分析 prompt：要求结论导向 + 问题定位 + 指标交叉验证。"""
    data = json.dumps(summary, ensure_ascii=False, indent=2)
    return (
        "你是 LLM 推理服务性能测试分析专家。以下是一次 vLLM 压力测试结束后的"
        "配置与指标摘要（JSON，字段名含单位：_s 为秒，toks_per_s 为 token/秒，"
        "rate/usage 类为 0-1 小数，None 表示该指标不可用）：\n\n"
        f"{data}\n\n"
        "请基于以上数据分析该次测试：\n"
        "1. 整体结论：吞吐与延迟表现是否与并发度、输入/输出长度配置匹配；\n"
        "2. 有问题或潜在问题的指标：如请求抢占（preemptions_total>0 说明 KV cache "
        "耗尽）、KV cache 占用接近 1、错误请求、排队堆积（waiting_requests_max）、"
        "TTFT/ITL 长尾、前缀缓存命中率异常等；\n"
        "3. 指标间联系是否自洽：如 e2e_avg_s ≈ ttft_avg_s + 输出token数 × "
        "tpot_avg_s、总吞吐与并发×单流速度的匹配、排队对 TTFT 的抬升等交叉"
        "验证，指出矛盾或异常之处。"
        + ("（注意：这是图形测试，输入为图片多模态请求，图片输入 token 数"
           "远大于文本 prompt，请结合 prompt_tokens_avg 评估图片 prefill "
           "开销对 TTFT/吞吐的影响。）"
           if (summary.get("profile") or {}).get("test_type") == "图形测试（图片理解 + 文章生成）"
           else "")
        + "\n\n"
        "要求：中文，500 字以内，直接给结论与依据，不要罗列原始数据，"
        "不要输出 JSON。"
    )


def _save(task_name: str, summary: dict, *, status: str,
          content: str = "", error: str = "") -> dict:
    """组装分析结果并持久化到 workspace/<任务名>/analysis.json。"""
    analysis = {
        "schema_version": 1,
        "task_name": task_name,
        "generated_at": round(time.time(), 1),
        "status": status,        # done | error
        "content": content,      # 分析结论（markdown 文本）
        "error": error,
        # 送入 LLM 的输入摘要（复现/调试用，不参与前端渲染）
        "summary": summary,
    }
    if workspace.valid_name(task_name):
        d = workspace._task_dir(task_name)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "analysis.json"), "w", encoding="utf-8") as f:
            json.dump(analysis, f, ensure_ascii=False, indent=2)
    return analysis


def load_analysis(task_name: str):
    """读取持久化分析；不存在或损坏时返回 None。"""
    if not workspace.valid_name(task_name):
        return None
    path = os.path.join(workspace._task_dir(task_name), "analysis.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


async def run_and_save(task_name: str,
                        prereq: "asyncio.Task | None" = None) -> dict:
    """生成分析并持久化（注册 pending，报告页生成期间显示"生成中"）。

    Args:
        prereq: 可选前置任务（如监控快照）。分析输入包含 Prometheus
            统计，故引擎挂钩处先等快照落盘再执行；快照失败不阻塞
            分析（仅少一份统计数据）。

    Returns:
        {"success": True, "analysis": {...}} 或 {"success": False, "error": str}
    """
    _PENDING.add(task_name)
    try:
        return await _run_and_save_impl(task_name, prereq)
    finally:
        _PENDING.discard(task_name)


async def _run_and_save_impl(task_name: str,
                             prereq: "asyncio.Task | None" = None) -> dict:
    """生成分析并持久化。

    Args:
        prereq: 可选前置任务（如监控快照）。分析输入包含 Prometheus
            统计，故引擎挂钩处先等快照落盘再执行；快照失败不阻塞
            分析（仅少一份统计数据）。

    Returns:
        {"success": True, "analysis": {...}} 或 {"success": False, "error": str}
    """
    if prereq is not None:
        try:
            await prereq
        except Exception:
            pass
    applog.log("analysis", f"开始生成 {task_name}")
    try:
        task = workspace.load_task(task_name)
        if task is None:
            applog.log("analysis", f"失败 {task_name} error=任务不存在")
            return {"success": False, "error": "任务不存在"}
        summary = _collect_summary(task, task_name)
        # 被测模型即分析模型：从任务 config 取 model_id 查当前配置
        model_id = ((task["config"].get("model") or {}).get("id")
                    or task["config"].get("params", {}).get("model_id"))
        model = model_store.get_model(model_id) if model_id else None
        if model is None:
            applog.log("analysis", f"失败 {task_name} error=被测模型配置已删除")
            return {"success": False, "error": "被测模型配置已删除，无法调用"}
        api_key = model_store.decode_key(model.get("api_key", ""))
        applog.log("analysis", f"调用被测模型 {task_name} model={model['model']} "
                   f"url={model['url']} max_tokens={_MAX_TOKENS}")
        t0 = time.time()
        r = await chat_completion(
            base_url=model["url"], model=model["model"],
            messages=[{"role": "user", "content": build_prompt(summary)}],
            api_key=api_key, max_tokens=_MAX_TOKENS, timeout=_TIMEOUT,
        )
        if not r["success"]:
            applog.log("analysis", f"失败 {task_name} 耗时={time.time() - t0:.1f}s "
                       f"error={r['error']}")
            _save(task_name, summary, status="error", error=r["error"])
            return {"success": False, "error": r["error"]}
        content = (r.get("content") or "").strip()
        if not content:
            applog.log("analysis", f"失败 {task_name} 耗时={time.time() - t0:.1f}s "
                       f"error=模型返回空内容")
            _save(task_name, summary, status="error", error="模型返回空内容")
            return {"success": False, "error": "模型返回空内容"}
        analysis = _save(task_name, summary, status="done", content=content)
        applog.log("analysis", f"完成 {task_name} 耗时={time.time() - t0:.1f}s "
                   f"content_chars={len(content)} analysis.json 已保存")
        return {"success": True, "analysis": analysis}
    except Exception as e:
        applog.log("analysis", f"异常 {task_name} "
                   f"error={type(e).__name__}: {e}")
        return {"success": False, "error": f"{type(e).__name__}: {e}"}
