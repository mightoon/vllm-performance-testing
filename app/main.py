"""LLM 测试平台 - FastAPI 后端入口。"""
import asyncio
import json
import time

from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional

from . import model_store
from .llm_client import verify_connection
from .test_engine import text_engine
import os

app = FastAPI(title="LLM 测试平台")

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
    return {"success": True, "model": updated}


@app.delete("/api/models/{model_id}")
def api_delete_model(model_id: str):
    ok = model_store.delete_model(model_id)
    if not ok:
        return JSONResponse({"success": False, "error": "配置不存在"}, 404)
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
    return await verify_connection(payload.url.strip(), payload.model.strip(),
                                   payload.api_key or "")


# ==================== 文本测试 API ====================

class TextTestPayload(BaseModel):
    model_id: str
    noun_count: int = 5
    article_length: int = 500
    concurrency: int = 2


@app.post("/api/tests/text/start")
async def api_text_start(payload: TextTestPayload):
    if payload.noun_count < 1 or payload.noun_count > 100:
        return JSONResponse({"success": False, "error": "名词数量需在 1-100 之间"}, 400)
    if payload.article_length < 50 or payload.article_length > 10000:
        return JSONResponse({"success": False, "error": "文章字数需在 50-10000 之间"}, 400)
    if payload.concurrency < 1 or payload.concurrency > 1000:
        return JSONResponse({"success": False, "error": "并发度需在 1-1000 之间"}, 400)
    return text_engine.start(payload.model_id, payload.noun_count,
                             payload.article_length, payload.concurrency)


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


# ==================== 静态页面 ====================

_static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")
