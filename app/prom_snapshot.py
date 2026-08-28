"""Prometheus 监控快照：测试结束时按起止时间拉取指标时序数据存档。

快照文件 workspace/<任务名>/metrics.json。报告模式优先读取快照，
无快照时回退为实时查询（受 Prometheus TSDB 保留期限制）。

指标清单为代码内常量（METRICS）：后续扩展（如 DCGM GPU 指标）
只需向列表追加条目；拉取时容忍单条缺失。
"""
import json
import math
import os
import time

import httpx

from . import workspace

# 指标清单：group 相同的序列前端渲染为同一张图。
# PromQL 兼容新旧 vLLM 命名（旧版无前缀，新版 vllm: 前缀；
# kv cache 指标新版由 gpu_cache_usage_perc 改名 kv_cache_usage_perc），
# 用 PromQL or 回退：前者无数据时自动使用后者。
METRICS = [
    {
        "key": "num_requests_running",
        "group": "concurrency",
        "legend": "运行中请求",
        "unit": "req",
        "promql": "num_requests_running or vllm:num_requests_running",
    },
    {
        "key": "num_requests_waiting",
        "group": "concurrency",
        "legend": "排队请求",
        "unit": "req",
        "promql": "num_requests_waiting or vllm:num_requests_waiting",
    },
    {
        "key": "kv_cache_usage",
        "group": "cache",
        "legend": "KV cache 使用率",
        "unit": "%",
        "promql": "gpu_cache_usage_perc or vllm:gpu_cache_usage_perc "
                  "or vllm:kv_cache_usage_perc or kv_cache_usage_perc",
    },
    {
        "key": "ttft_p50",
        "group": "latency",
        "legend": "TTFT p50",
        "unit": "s",
        "promql": "histogram_quantile(0.5, sum by (le) (rate(time_to_first_token_seconds_bucket[30s]))) "
                  "or histogram_quantile(0.5, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket[30s])))",
    },
    {
        "key": "ttft_p95",
        "group": "latency",
        "legend": "TTFT p95",
        "unit": "s",
        "promql": "histogram_quantile(0.95, sum by (le) (rate(time_to_first_token_seconds_bucket[30s]))) "
                  "or histogram_quantile(0.95, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket[30s])))",
    },
    {
        "key": "gen_throughput",
        "group": "throughput",
        "legend": "生成吞吐",
        "unit": "tok/s",
        "promql": "rate(generation_tokens_total[1m]) or rate(vllm:generation_tokens_total[1m])",
    },
    {
        "key": "preemptions_rate",
        "group": "preemption",
        "legend": "请求抢占速率",
        "unit": "req/s",
        "promql": "rate(num_preemptions_total[1m]) or rate(vllm:num_preemptions_total[1m])",
    },
]


def _step_for(start: float, end: float) -> int:
    """step 自适应：每序列约 240 点，下限 5 秒。"""
    elapsed = max(1.0, end - start)
    return max(5, int(elapsed / 240))


async def _query_range(client: httpx.AsyncClient, base_url: str, promql: str,
                       start: float, end: float, step: int) -> list:
    """单条 query_range。返回 [t, v] 点列表；失败/无数据返回 []。"""
    try:
        url = base_url.rstrip("/") + "/api/v1/query_range"
        resp = await client.get(url, params={
            "query": promql, "start": start, "end": end, "step": step})
        if resp.status_code != 200:
            return []
        data = resp.json()
        if data.get("status") != "success":
            return []
        # 多序列（如多实例）时取点数最多的一条
        best = []
        for item in data.get("data", {}).get("result", []):
            values = item.get("values") or []
            if len(values) > len(best):
                best = values
        return best
    except Exception:
        return []


def _clean_vals(series_entry: dict) -> list:
    """取出序列中的有效数值（过滤 NaN）。"""
    return [v for _, v in series_entry.get("data", [])
            if v is not None and not (isinstance(v, float) and math.isnan(v))]


def _compute_stats(series: list) -> dict:
    """预计算统计卡片数值，前端直接展示。"""
    by_key = {s["key"]: s for s in series}

    def avg(key: str, scale: float = 1.0):
        vals = _clean_vals(by_key.get(key, {}))
        return round(sum(vals) / len(vals) * scale, 1) if vals else None

    def peak(key: str, scale: float = 1.0):
        vals = _clean_vals(by_key.get(key, {}))
        return round(max(vals) * scale, 1) if vals else None

    return {
        "gen_throughput_avg": avg("gen_throughput"),
        "gen_throughput_peak": peak("gen_throughput"),
        "ttft_p50_avg_ms": avg("ttft_p50", 1000.0),
        "ttft_p95_peak_ms": peak("ttft_p95", 1000.0),
        # kv_cache_usage 原始值为 0-1 小数，换算为百分比
        "kv_cache_peak_perc": peak("kv_cache_usage", 100.0),
        # 抢占速率峰值：>0 说明测试期间 KV cache 曾耗尽（精确累计
        # 次数见报告 vLLM 指标区的"累计抢占次数"）
        "preemptions_rate_peak": peak("preemptions_rate"),
    }


def _to_f(v) -> float:
    """Prometheus 值转 float；NaN（直方图无数据窗口）转为 None。"""
    f = float(v)
    return None if math.isnan(f) else round(f, 4)


async def fetch_snapshot(base_url: str, start: float, end: float) -> dict:
    """按起止时间拉取全部指标，组装快照 dict。单条失败跳过，不整体失败。
    Prometheus 不可达时静默返回空快照，不抛异常。"""
    try:
        step = _step_for(start, end)
        series = []
        async with httpx.AsyncClient(timeout=10.0) as client:
            for m in METRICS:
                values = await _query_range(client, base_url, m["promql"],
                                            start, end, step)
                if not values:
                    continue
                series.append({
                    "key": m["key"],
                    "group": m["group"],
                    "legend": m["legend"],
                    "unit": m["unit"],
                    "promql": m["promql"],
                    # Prometheus 返回的 value 为字符串，转 float（NaN → None）
                    "data": [[t, _to_f(v)] for t, v in values],
                })
        return {
            "schema_version": 1,
            "source": base_url,
            "range": {"start": start, "end": end, "step": step},
            "fetched_at": time.time(),
            "series": series,
            "stats": _compute_stats(series),
        }
    except Exception:
        return {
            "schema_version": 1,
            "source": base_url,
            "range": {"start": start, "end": end, "step": 0},
            "fetched_at": time.time(),
            "series": [],
            "stats": {},
        }


async def test_connection(base_url: str) -> dict:
    """连通性验证：查询 up。Prometheus 不可达时静默返回失败，不抛异常。"""
    url = base_url.rstrip("/") + "/api/v1/query"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(url, params={"query": "up"})
        if resp.status_code == 200 and resp.json().get("status") == "success":
            return {"success": True}
        return {"success": False, "error": f"HTTP {resp.status_code}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


def save_metrics(task_name: str, snap: dict) -> None:
    if not workspace.valid_name(task_name):
        return
    d = workspace._task_dir(task_name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "metrics.json"), "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False)


def load_metrics(task_name: str):
    """读取快照；不存在或损坏时返回 None。"""
    if not workspace.valid_name(task_name):
        return None
    path = os.path.join(workspace._task_dir(task_name), "metrics.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None
