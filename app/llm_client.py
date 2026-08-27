"""LLM API 客户端（OpenAI 兼容接口）。"""
import json
import re

import httpx


async def chat_completion(base_url: str, model: str, messages: list,
                          api_key: str = "", max_tokens: int = 2048,
                          timeout: float = 300.0,
                          temperature: float | None = None,
                          response_format: dict | None = None) -> dict:
    """调用 OpenAI 兼容的 chat/completions 接口。

    Args:
        temperature: 采样温度。None 表示不传（用服务端默认）；
                     需要确定性输出（如结构化解析场景）时传 0.0~0.3。
        response_format: 输出格式约束，如 {"type": "json_object"}。
                         vLLM/OpenAI 均支持；不支持的 server 会返回 4xx，
                         调用方应准备无该参数的重试路径。

    Returns:
        {"success": True, "content": str} 或 {"success": False, "error": str}
    """
    url = base_url.rstrip("/")
    if not url.endswith("/chat/completions"):
        url = url + "/chat/completions"

    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": False,
        # 禁用思考过程：所有问答都建立在关闭 thinking 的基础上
        "chat_template_kwargs": {"enable_thinking": False, "thinking": False},
    }
    if temperature is not None:
        payload["temperature"] = temperature
    if response_format is not None:
        payload["response_format"] = response_format

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code == 200:
            data = resp.json()
            content = ""
            try:
                content = data["choices"][0]["message"]["content"] or ""
            except (KeyError, IndexError, TypeError):
                pass
            return {"success": True, "content": content}
        # 错误处理：提取可读信息
        try:
            err = resp.json()
            detail = err.get("error", {}).get("message", "") or resp.text[:200]
        except Exception:
            detail = resp.text[:200]
        return {"success": False, "error": f"HTTP {resp.status_code}: {detail}"}
    except httpx.TimeoutException as e:
        # 注意：客户端超时放弃后，服务端往往仍会完成请求并记录 200，
        # 所以 vLLM 日志全 200 与此错误不矛盾。带异常子类便于区分
        # ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout。
        return {"success": False, "error": f"请求超时（{type(e).__name__}）"}
    except httpx.ConnectError as e:
        return {"success": False, "error": f"无法连接到服务器（检查 base_url）: {e}"}
    except Exception as e:
        # 覆盖：响应体不完整(RemoteProtocolError)、JSON 解析失败、
        # 连接被重置(ReadError)等——这些场景下 vLLM 端可能已记录 200
        return {"success": False, "error": f"{type(e).__name__}: {e}"}


async def verify_connection(base_url: str, model: str, api_key: str = "") -> dict:
    """发送最小请求验证模型连接。auth/model not found 报具体原因，其他错误视为可连接。"""
    result = await chat_completion(
        base_url=base_url, model=model,
        messages=[{"role": "user", "content": "Hi"}],
        api_key=api_key, max_tokens=5, timeout=30.0,
    )
    if result["success"]:
        return {"success": True}
    err = result["error"]
    low = err.lower()
    if "401" in low or "403" in low or "auth" in low or "api key" in low or "unauthorized" in low:
        return {"success": False, "error": f"认证失败：{err}"}
    if "404" in low or "model" in low and "not" in low:
        return {"success": False, "error": f"模型不存在：{err}"}
    # 其他错误（如 max_tokens 太小被拒、超时前的响应等）视为服务器可达
    if "无法连接" in err or "超时" in err:
        return {"success": False, "error": err}
    return {"success": True}


async def chat_completion_stream(base_url: str, model: str, messages: list,
                                 api_key: str = "", max_tokens: int = 2048,
                                 timeout: float = 600.0,
                                 temperature: float | None = None,
                                 on_chunk=None) -> dict:
    """流式调用 chat/completions（SSE），边生成边通过 on_chunk 回调增量文本。

    相比非流式：read timeout 作用于相邻 chunk 之间而非整个请求，
    长文章生成不会因总时长超时被误杀。

    Args:
        on_chunk: 回调 fn(delta_text: str)，在 asyncio 事件循环内同步调用。

    Returns:
        {"success": True, "content": 完整文本} 或 {"success": False, "error": str}
    """
    url = base_url.rstrip("/")
    if not url.endswith("/chat/completions"):
        url = url + "/chat/completions"

    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": True,
        # 禁用思考过程：所有问答都建立在关闭 thinking 的基础上
        "chat_template_kwargs": {"enable_thinking": False, "thinking": False},
    }
    if temperature is not None:
        payload["temperature"] = temperature

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    full = []
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", url, json=payload,
                                     headers=headers) as resp:
                if resp.status_code != 200:
                    body = (await resp.aread()).decode("utf-8", "replace")
                    try:
                        err = json.loads(body)
                        detail = err.get("error", {}).get("message", "") or body[:200]
                    except json.JSONDecodeError:
                        detail = body[:200]
                    return {"success": False,
                            "error": f"HTTP {resp.status_code}: {detail}"}
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        obj = json.loads(data)
                        delta = obj["choices"][0]["delta"].get("content") or ""
                    except (json.JSONDecodeError, KeyError, IndexError, TypeError):
                        continue
                    if delta:
                        full.append(delta)
                        if on_chunk:
                            try:
                                on_chunk(delta)
                            except Exception:
                                pass
        return {"success": True, "content": "".join(full)}
    except httpx.TimeoutException as e:
        return {"success": False, "error": f"请求超时（{type(e).__name__}）"}
    except httpx.ConnectError as e:
        return {"success": False, "error": f"无法连接到服务器（检查 base_url）: {e}"}
    except Exception as e:
        return {"success": False, "error": f"{type(e).__name__}: {e}"}


def _metrics_url(base_url: str) -> str:
    """从 chat base_url 推导 vLLM /metrics 端点。

    http://h:8000/v1/chat/completions -> http://h:8000/metrics
    http://h:8000/v1                 -> http://h:8000/metrics
    http://h:8000                    -> http://h:8000/metrics
    """
    url = base_url.rstrip("/")
    for suffix in ("/chat/completions", "/v1"):
        if url.endswith(suffix):
            url = url[: -len(suffix)]
            break
    return url.rstrip("/") + "/metrics"


def _parse_prometheus(text: str) -> dict:
    """解析 Prometheus 文本格式为 {指标名: 值}（带 label 的取最后一条）。"""
    result = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)", line)
        if not m:
            continue
        name, _, value = m.groups()
        try:
            result[name] = float(value)
        except ValueError:
            continue
    return result


def extract_vllm_metrics(raw: dict) -> dict:
    """从原始指标 dict 提取主要指标（兼容不同 vLLM 版本的命名差异）。"""
    def find(*names):
        # 第一轮：精确匹配（name / vllm:name）。
        # 避免 external_prefix_cache_hits_total 等同后缀指标被误命中
        for n in names:
            if n in raw:
                return raw[n]
            vn = "vllm:" + n
            if vn in raw:
                return raw[vn]
        # 第二轮：后缀/包含匹配，兜底兼容旧版本命名变体
        for n in names:
            for k, v in raw.items():
                if k.endswith(n) or n in k:
                    return v
        return None

    ttft_sum = find("time_to_first_token_seconds_sum")
    ttft_cnt = find("time_to_first_token_seconds_count")
    tpot_sum = find("request_time_per_output_token_seconds_sum",
                    "time_per_output_token_seconds_sum")
    tpot_cnt = find("request_time_per_output_token_seconds_count",
                    "time_per_output_token_seconds_count")
    # 前缀缓存命中：新版 vLLM 是 hits/queries 两个 counter，旧版是现成 rate gauge
    pc_hits = find("prefix_cache_hits_total")
    pc_queries = find("prefix_cache_queries_total")
    if pc_hits is not None and pc_queries:
        prefix_rate = round(pc_hits / pc_queries, 4)
    else:
        prefix_rate = find("gpu_prefix_cache_hit_rate", "prefix_cache_hit_rate")
    return {
        "running_requests": find("num_requests_running"),
        "waiting_requests": find("num_requests_waiting"),
        # 新版 vLLM 改名 kv_cache_usage_perc（旧版为 gpu_cache_usage_perc）
        "gpu_cache_usage": find("kv_cache_usage_perc", "gpu_cache_usage_perc",
                                "gpu_cache_usage_ratio", "gpu_cache_usage"),
        "prefix_cache_hit_rate": prefix_rate,
        # 新版 vLLM 移除了吞吐 gauge；为 None 时由引擎差分计算 tok/s
        "gen_throughput_toks": find("avg_generation_throughput_toks_per_s",
                                    "generation_throughput"),
        "prompt_tokens_total": find("prompt_tokens_total"),
        "generation_tokens_total": find("generation_tokens_total"),
        "ttft_avg_s": round(ttft_sum / ttft_cnt, 3)
        if ttft_sum is not None and ttft_cnt else None,
        "tpot_avg_s": round(tpot_sum / tpot_cnt, 3)
        if tpot_sum is not None and tpot_cnt else None,
    }


async def fetch_vllm_metrics(base_url: str, api_key: str = "",
                             timeout: float = 10.0) -> dict:
    """抓取 vLLM /metrics 并返回提取后的主要指标。

    Returns:
        {"success": True, "metrics": {...}} 或 {"success": False, "error": str}
    """
    url = _metrics_url(base_url)
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            return {"success": False,
                    "error": f"HTTP {resp.status_code}（{url}）"}
        return {"success": True,
                "metrics": extract_vllm_metrics(_parse_prometheus(resp.text))}
    except Exception as e:
        return {"success": False, "error": f"{type(e).__name__}: {e}"}
