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

# 指标清单：group 相同的序列前端渲染为同一张图（每行两图，共四行：
# e2e/latency → itl/phase → throughput/gpu → concurrency/preemption）。
# PromQL 兼容新旧 vLLM 命名（旧版无前缀，新版 vllm: 前缀；
# kv cache 指标新版由 gpu_cache_usage_perc 改名 kv_cache_usage_perc），
# 用 PromQL or 回退：前者无数据时自动使用后者。
# hidden=True 的序列只参与统计卡片计算，不渲染进图表。
METRICS = [
    # ---- 第一行左图：端到端请求延迟分位数（含 tokenize/排队/生成全程）----
    {
        "key": "e2e_p50",
        "group": "e2e",
        "legend": "P50",
        "unit": "s",
        "promql": "histogram_quantile(0.5, sum by (le) (rate(e2e_request_latency_seconds_bucket[30s]))) "
                  "or histogram_quantile(0.5, sum by (le) (rate(vllm:e2e_request_latency_seconds_bucket[30s])))",
    },
    {
        "key": "e2e_p95",
        "group": "e2e",
        "legend": "P95",
        "unit": "s",
        "promql": "histogram_quantile(0.95, sum by (le) (rate(e2e_request_latency_seconds_bucket[30s]))) "
                  "or histogram_quantile(0.95, sum by (le) (rate(vllm:e2e_request_latency_seconds_bucket[30s])))",
    },
    {
        "key": "e2e_p99",
        "group": "e2e",
        "legend": "P99",
        "unit": "s",
        "promql": "histogram_quantile(0.99, sum by (le) (rate(e2e_request_latency_seconds_bucket[30s]))) "
                  "or histogram_quantile(0.99, sum by (le) (rate(vllm:e2e_request_latency_seconds_bucket[30s])))",
    },
    # ---- 第一行右图：首 token 延迟（TTFT）分位数 ----
    {
        "key": "ttft_p50",
        "group": "latency",
        "legend": "P50",
        "unit": "s",
        "promql": "histogram_quantile(0.5, sum by (le) (rate(time_to_first_token_seconds_bucket[30s]))) "
                  "or histogram_quantile(0.5, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket[30s])))",
    },
    {
        "key": "ttft_p95",
        "group": "latency",
        "legend": "P95",
        "unit": "s",
        "promql": "histogram_quantile(0.95, sum by (le) (rate(time_to_first_token_seconds_bucket[30s]))) "
                  "or histogram_quantile(0.95, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket[30s])))",
    },
    {
        "key": "ttft_p99",
        "group": "latency",
        "legend": "P99",
        "unit": "s",
        "promql": "histogram_quantile(0.99, sum by (le) (rate(time_to_first_token_seconds_bucket[30s]))) "
                  "or histogram_quantile(0.99, sum by (le) (rate(vllm:time_to_first_token_seconds_bucket[30s])))",
    },
    # ---- 第二行左图：token 间隔延迟（ITL）分位数 + TPOT 均值 ----
    # ITL 相邻 token 间隔的分布：P99 暴露流式抖动（卡顿尖刺）；
    # TPOT 为每输出 token 平均时间（sum/count 速率比，请求等权均值）
    {
        "key": "itl_p50",
        "group": "itl",
        "legend": "ITL P50",
        "unit": "s",
        "promql": "histogram_quantile(0.5, sum by (le) (rate(inter_token_latency_seconds_bucket[30s]))) "
                  "or histogram_quantile(0.5, sum by (le) (rate(vllm:inter_token_latency_seconds_bucket[30s])))",
    },
    {
        "key": "itl_p95",
        "group": "itl",
        "legend": "ITL P95",
        "unit": "s",
        "promql": "histogram_quantile(0.95, sum by (le) (rate(inter_token_latency_seconds_bucket[30s]))) "
                  "or histogram_quantile(0.95, sum by (le) (rate(vllm:inter_token_latency_seconds_bucket[30s])))",
    },
    {
        "key": "itl_p99",
        "group": "itl",
        "legend": "ITL P99",
        "unit": "s",
        "promql": "histogram_quantile(0.99, sum by (le) (rate(inter_token_latency_seconds_bucket[30s]))) "
                  "or histogram_quantile(0.99, sum by (le) (rate(vllm:inter_token_latency_seconds_bucket[30s])))",
    },
    {
        "key": "tpot_avg",
        "group": "itl",
        "legend": "TPOT 均值",
        "unit": "s",
        # 新版 vLLM 直方图名为 request_time_per_output_token_seconds，
        # 旧版为 time_per_output_token_seconds；各覆盖 bare / vllm: 前缀
        "promql": "(rate(request_time_per_output_token_seconds_sum[30s]) / "
                  "rate(request_time_per_output_token_seconds_count[30s])) "
                  "or (rate(vllm:request_time_per_output_token_seconds_sum[30s]) / "
                  "rate(vllm:request_time_per_output_token_seconds_count[30s])) "
                  "or (rate(time_per_output_token_seconds_sum[30s]) / "
                  "rate(time_per_output_token_seconds_count[30s])) "
                  "or (rate(vllm:time_per_output_token_seconds_sum[30s]) / "
                  "rate(vllm:time_per_output_token_seconds_count[30s]))",
    },
    # ---- 第二行右图：排队 / Prefill / Decode 阶段耗时 P95 ----
    # （较新 vLLM 才暴露；旧版查询无数据自动跳过）
    {
        "key": "queue_p95",
        "group": "phase",
        "legend": "Queue P95",
        "unit": "s",
        "promql": "histogram_quantile(0.95, sum by (le) (rate(request_queue_time_seconds_bucket[30s]))) "
                  "or histogram_quantile(0.95, sum by (le) (rate(vllm:request_queue_time_seconds_bucket[30s])))",
    },
    {
        "key": "prefill_p95",
        "group": "phase",
        "legend": "Prefill P95",
        "unit": "s",
        "promql": "histogram_quantile(0.95, sum by (le) (rate(request_prefill_time_seconds_bucket[30s]))) "
                  "or histogram_quantile(0.95, sum by (le) (rate(vllm:request_prefill_time_seconds_bucket[30s])))",
    },
    {
        "key": "decode_p95",
        "group": "phase",
        "legend": "Decode P95",
        "unit": "s",
        "promql": "histogram_quantile(0.95, sum by (le) (rate(request_decode_time_seconds_bucket[30s]))) "
                  "or histogram_quantile(0.95, sum by (le) (rate(vllm:request_decode_time_seconds_bucket[30s])))",
    },
    # ---- 第三行左图：生成吞吐（irate 瞬时速率）----
    {
        "key": "gen_throughput",
        "group": "throughput",
        "legend": "生成吞吐",
        "unit": "tok/s",
        "promql": "irate(generation_tokens_total[1m]) or irate(vllm:generation_tokens_total[1m])",
    },
    # ---- 第三行右图：KV cache 与 GPU 利用率（均 0-100%，共轴）----
    {
        "key": "kv_cache_usage",
        "group": "gpu",
        "legend": "KV cache 使用率",
        "unit": "%",
        "promql": "gpu_cache_usage_perc or vllm:gpu_cache_usage_perc "
                  "or vllm:kv_cache_usage_perc or kv_cache_usage_perc",
    },
    {
        "key": "gpu_mem_copy_util",
        "group": "gpu",
        "legend": "显存控制器使用率",
        "unit": "%",
        "promql": "avg(DCGM_FI_DEV_MEM_COPY_UTIL)",
    },
    {
        "key": "gpu_util",
        "group": "gpu",
        "legend": "GPU 计算利用率",
        "unit": "%",
        "promql": "avg(DCGM_FI_DEV_GPU_UTIL)",
    },
    # ---- 第四行左图：并发与排队 ----
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
    # ---- 第四行右图：请求抢占 ----
    {
        "key": "preemptions_rate",
        "group": "preemption",
        "legend": "请求抢占速率",
        "unit": "req/s",
        "promql": "irate(num_preemptions_total[1m]) or irate(vllm:num_preemptions_total[1m])",
    },
    # ---- 仅统计用（hidden，不进图）：GPU 显存使用率 ----
    # 卡片"GPU 显存使用率"与报告 Metrics"资源指标"组消费其均值
    {
        "key": "gpu_fb_usage",
        "group": "gpu",
        "legend": "显存使用率",
        "unit": "%",
        "hidden": True,
        "promql": "avg(DCGM_FI_DEV_FB_USED / "
                  "(DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE)) * 100",
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
        "gen_throughput_peak": peak("gen_throughput"),
        # kv_cache_usage 原始值为 0-1 小数，换算为百分比
        "kv_cache_peak_perc": peak("kv_cache_usage", 100.0),
        # 抢占速率峰值：>0 说明测试期间 KV cache 曾耗尽（精确累计
        # 次数见报告 vLLM 指标区的"累计抢占次数"）
        "preemptions_rate_peak": peak("preemptions_rate"),
        # DCGM GPU 显存（各卡平均，报告"资源指标"组与监控卡片展示；
        # 序列原始值已是 0-100 百分比）
        "gpu_fb_usage_avg": avg("gpu_fb_usage"),
        "gpu_mem_copy_util_avg": avg("gpu_mem_copy_util"),
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
                    "hidden": bool(m.get("hidden")),
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
