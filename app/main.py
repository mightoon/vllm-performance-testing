"""LLM 测试平台 - FastAPI 后端入口。"""
import asyncio
import json
import time

from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional

from . import _paths
from . import analysis
from . import applog
from . import model_store
from . import prom_snapshot
from . import workspace
from .llm_client import verify_connection
from .test_engine import text_engine

# PyInstaller 模式下首次运行时复制内置 config.json 到可执行文件目录
_paths.ensure_config()

app = FastAPI(title="LLM 测试平台")


# API 访问日志：log.enabled 开启时记录每次 /api/ 请求（方法/路径/状态/耗时）。
# 静态资源请求（页面/JS/CSS）不记录，避免轮询页面时刷屏
@app.middleware("http")
async def _log_api_requests(request, call_next):
    if not request.url.path.startswith("/api/"):
        return await call_next(request)
    t0 = time.time()
    response = await call_next(request)
    applog.log("api", f"{request.method} {request.url.path} -> "
               f"{response.status_code} ({(time.time() - t0) * 1000:.0f}ms)")
    return response

# ==================== 模型管理 API ====================

class ModelPayload(BaseModel):
    name: str
    model: str
    url: str
    api_key: Optional[str] = ""


@app.get("/api/models")
def api_list_models():
    return model_store.list_models()


@app.post("/api/models")
def api_add_model(payload: ModelPayload):
    if not payload.name or not payload.model or not payload.url:
        return JSONResponse({"success": False, "error": "名称、模型ID、Base URL 均不能为空"}, 400)
    m = model_store.add_model(payload.name.strip(), payload.model.strip(),
                              payload.url.strip(), payload.api_key or "")
    applog.log("model", f"新增模型 id={m['id']} name={m['name']} "
               f"model={m['model']} url={m['url']} "
               f"api_key={'已设置' if m['has_api_key'] else '无'}")
    return {"success": True, "model": m}


@app.put("/api/models/{model_id}")
def api_update_model(model_id: str, payload: ModelPayload):
    updated = model_store.update_model(
        model_id,
        name=payload.name or None,
        model=payload.model or None,
        url=payload.url or None,
        api_key=payload.api_key,  # None 不变；空串清除
    )
    if updated is None:
        return JSONResponse({"success": False, "error": "配置不存在"}, 404)
    applog.log("model", f"更新模型 id={updated['id']} name={updated['name']} "
               f"model={updated['model']} url={updated['url']}")
    return {"success": True, "model": updated}


@app.delete("/api/models/{model_id}")
def api_delete_model(model_id: str):
    ok = model_store.delete_model(model_id)
    if not ok:
        return JSONResponse({"success": False, "error": "配置不存在"}, 404)
    applog.log("model", f"删除模型 id={model_id}")
    return {"success": True}


@app.get("/api/models/{model_id}/apikey")
def api_get_apikey(model_id: str):
    key = model_store.get_model_apikey(model_id)
    if key is None:
        return JSONResponse({"success": False, "error": "配置不存在"}, 404)
    return {"api_key": key}


@app.post("/api/verify-model")
async def api_verify_model(payload: ModelPayload):
    if not payload.model or not payload.url:
        return {"success": False, "error": "模型ID 和 Base URL 不能为空"}
    r = await verify_connection(payload.url.strip(), payload.model.strip(),
                                payload.api_key or "")
    applog.log("model", f"验证连接 model={payload.model} url={payload.url} "
               f"result={'成功' if r['success'] else '失败: ' + r.get('error', '')}")
    return r


# ==================== 模型服务端能力探测 ====================

# 探测结果缓存：model_id -> {"fingerprint": (url, model, api_key), "data": {...}}
# 指纹（服务地址/模型ID/Key）变化时自动失效重探
_probe_cache: dict = {}


async def _probe_model_cached(model_id: str) -> dict | None:
    """探测模型服务端参数（带指纹缓存）；配置不存在或探测失败返回 None。

    供 probe API 与测试启动共用：启动测试时调用可命中缓存（前端选模型
    时已探测过），几乎零开销。
    """
    from .llm_client import probe_model_info
    m = model_store.get_model(model_id)
    if m is None:
        return None
    api_key = model_store.decode_key(m.get("api_key", ""))
    fp = (m.get("url", ""), m.get("model", ""), api_key)
    cached = _probe_cache.get(model_id)
    if cached and cached["fingerprint"] == fp:
        return cached["data"]
    data = await probe_model_info(m["url"], m["model"], api_key)
    _probe_cache[model_id] = {"fingerprint": fp, "data": data}
    return data


@app.get("/api/models/{model_id}/probe")
async def api_probe_model(model_id: str):
    """探测模型服务端关键配置（vLLM 版本 / 最大上下文 / KV cache 容量）。

    结果按模型配置指纹缓存，切换模型不重复探测。
    """
    data = await _probe_model_cached(model_id)
    if data is None:
        return JSONResponse({"success": False, "error": "配置不存在"}, 404)
    return {"success": True, **data}


# ==================== 文本测试 API ====================

class TextTestPayload(BaseModel):
    model_id: str
    input_length: str = "tiny"
    noun_count: int = 5
    article_length: int = 500
    concurrency: int = 2


@app.post("/api/tests/text/start")
async def api_text_start(payload: TextTestPayload):
    from .prompt_templates import LENGTH_SPECS
    if payload.input_length not in LENGTH_SPECS:
        return JSONResponse({"success": False, "error": "输入长度档位非法"}, 400)
    if payload.noun_count < 1 or payload.noun_count > 100:
        return JSONResponse({"success": False, "error": "迭代次数需在 1-100 之间"}, 400)
    if payload.article_length < 10 or payload.article_length > 10000:
        return JSONResponse({"success": False, "error": "输出长度需在 10-10000 token 之间"}, 400)
    if payload.concurrency < 1 or payload.concurrency > 1000:
        return JSONResponse({"success": False, "error": "并发度需在 1-1000 之间"}, 400)
    # 启动时刻快照模型服务端参数（vLLM 版本/最大上下文/KV 容量），随任务
    # 持久化到 config，报告模式 Profile 区域的数据源。探测失败不阻塞启动
    # （前端 Profile 显示 "—"）。前端选模型时已探测过，此处通常命中缓存。
    probe = await _probe_model_cached(payload.model_id)
    return text_engine.start(payload.model_id, payload.noun_count,
                             payload.article_length, payload.concurrency,
                             payload.input_length, probe=probe)


@app.get("/api/tests/text/status")
def api_text_status():
    return text_engine.status_dict()


@app.get("/api/tests/text/case/{case_id}")
def api_text_case_detail(case_id: int):
    """单个 case 详情（含问答历史与端到端性能指标），供详情弹窗轮询。"""
    detail = text_engine.case_detail(case_id)
    if detail is None:
        return JSONResponse({"success": False, "error": "case 不存在"}, 404)
    return {
        "success": True,
        "case": detail,
        "test_status": text_engine.status,
    }


def _sse(event: str, data: dict) -> str:
    """格式化一条 SSE 消息。"""
    payload = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


@app.get("/api/tests/text/case/{case_id}/stream")
async def api_text_case_stream(case_id: int):
    """单个 case 的 SSE 实时流：
    - snapshot: qa 结构变化（新问答开始/结束）时推送完整快照
    - delta:    正在生成的回答的文本增量（约 250ms 一批，实现平滑流式效果）
    - stats:    运行数据与端到端性能指标，每 5s 推送一次
    - end:      case 结束（完成/出错/停止）后推送并关闭流
    """
    if text_engine.get_case(case_id) is None:
        return JSONResponse({"success": False, "error": "case 不存在"}, 404)

    async def event_stream():
        last_version = -1          # 上次快照时的 qa_version
        last_lens: list[int] = []  # 上次推送时各 qa 的 partial 长度
        last_stats_ts = 0.0        # 上次推送 stats 的时间
        try:
            while True:
                case = text_engine.get_case(case_id)
                if case is None:
                    yield _sse("end", {})
                    return

                # 测试结束或该 case 已终态 → 推最终快照并关闭
                finished = (
                    text_engine.status != "running"
                    or case.status in ("completed", "error", "stopped")
                )

                if finished or case.qa_version != last_version:
                    detail = text_engine.case_detail(case_id)
                    yield _sse("snapshot", {
                        "case": detail,
                        "test_status": text_engine.status,
                    })
                    last_version = case.qa_version
                    last_lens = [len(q.get("partial") or "") for q in case.qa_history]
                    if finished:
                        yield _sse("end", {})
                        return
                else:
                    # 只推送正在生成的 qa 的文本增量
                    for idx, qa in enumerate(case.qa_history):
                        if qa.get("status") != "generating":
                            continue
                        partial = qa.get("partial") or ""
                        prev = last_lens[idx] if idx < len(last_lens) else 0
                        if len(partial) > prev:
                            yield _sse("delta", {
                                "i": idx,
                                "text": partial[prev:],
                                "chars": len(partial),
                            })
                            last_lens[idx] = len(partial)

                now = time.time()
                if now - last_stats_ts >= 5.0:
                    last_stats_ts = now
                    yield _sse("stats", {
                        "case": text_engine.case_detail(case_id, include_qa=False),
                        "test_status": text_engine.status,
                    })

                await asyncio.sleep(0.25)
        except asyncio.CancelledError:
            # 客户端断开（关闭弹窗）时由 FastAPI 触发，直接结束
            return

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.post("/api/tests/text/stop")
async def api_text_stop():
    return text_engine.stop()


@app.get("/api/tests/text/history")
def api_text_history():
    """历史文本测试任务列表（按开始时间倒序）。"""
    return {"success": True, "tasks": workspace.list_history("文本测试")}


@app.get("/api/tests/text/history/{task_name}")
def api_text_history_detail(task_name: str):
    """单个历史任务的完整配置与结果（报告模式数据源）。"""
    task = workspace.load_task(task_name)
    if task is None:
        return JSONResponse({"success": False, "error": "任务不存在"}, 404)
    return {"success": True, "config": task["config"], "result": task["result"]}


@app.delete("/api/tests/text/history/{task_name}")
def api_text_history_delete(task_name: str):
    """删除历史任务：整体移除 workspace/<任务名>/ 目录（含结果与监控快照）。"""
    # 运行中的任务禁止删除（目录正被引擎写入）
    if (text_engine.task_name == task_name
            and text_engine.status in ("running", "stopping")):
        return JSONResponse({"success": False, "error": "任务运行中，无法删除"}, 409)
    try:
        ok = workspace.delete_task(task_name)
    except OSError as e:
        return JSONResponse({"success": False, "error": f"删除失败：{e}"}, 500)
    if not ok:
        return JSONResponse({"success": False, "error": "任务不存在"}, 404)
    applog.log("test", f"删除历史任务 {task_name}")
    return {"success": True}


# ==================== Prometheus 监控 ====================

class PromConfigPayload(BaseModel):
    url: str
    grafana_url: Optional[str] = ""


@app.get("/api/prometheus/config")
def api_prom_config_get():
    return {"success": True, "config": model_store.get_prometheus_config()}


@app.put("/api/prometheus/config")
def api_prom_config_put(payload: PromConfigPayload):
    url = payload.url.strip()
    if not url:
        return JSONResponse({"success": False, "error": "Prometheus URL 不能为空"}, 400)
    if not url.startswith(("http://", "https://")):
        return JSONResponse({"success": False, "error": "URL 需以 http:// 或 https:// 开头"}, 400)
    cfg = model_store.save_prometheus_config(url, payload.grafana_url or "")
    applog.log("model", f"保存 Prometheus 配置 url={url} "
               f"grafana_url={payload.grafana_url or '无'}")
    return {"success": True, "config": cfg}


@app.post("/api/prometheus/test")
async def api_prom_test(payload: PromConfigPayload):
    url = payload.url.strip()
    if not url:
        return JSONResponse({"success": False, "error": "URL 不能为空"}, 400)
    try:
        return await prom_snapshot.test_connection(url)
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.get("/api/tests/text/history/{task_name}/metrics")
async def api_text_history_metrics(task_name: str):
    """报告模式监控数据。三级回退：快照 → 实时查询 → 空。"""
    # 1. 快照优先（测试结束时存档，不受 TSDB 保留期限制）
    snap = prom_snapshot.load_metrics(task_name)
    if snap:
        return {"success": True, "source": "snapshot", "metrics": snap}
    # 2. 无快照但有 Prometheus 配置：按任务起止时间实时查询（15 天内有效）
    url = model_store.get_prometheus_config().get("url", "")
    if url:
        task = workspace.load_task(task_name)
        if task:
            started = float(task["config"].get("started_at") or 0)
            elapsed = float(task["result"].get("elapsed") or 0)
            ended = started + elapsed
            if started > 0 and ended > started:
                try:
                    snap = await prom_snapshot.fetch_snapshot(url, started, ended)
                    if snap.get("series"):
                        return {"success": True, "source": "live", "metrics": snap}
                except Exception:
                    pass  # 实时查询失败：走空数据兜底
    # 3. 无监控数据
    return {"success": True, "source": None, "metrics": None}


# ==================== 测试结果 AI 分析 ====================

@app.get("/api/tests/text/history/{task_name}/analysis")
def api_text_history_analysis(task_name: str):
    """读取持久化的 AI 分析结论（无则 analysis 为 null）。

    pending: 后台正在生成中（报告页显示"生成中"并轮询）。
    """
    return {
        "success": True,
        "analysis": analysis.load_analysis(task_name),
        "pending": analysis.is_pending(task_name),
    }


# ==================== 静态页面 ====================

_static_dir = _paths.static_dir()
app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")
