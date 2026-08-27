"""文本测试执行引擎。

每个 case：从本地名词库（1000 词）随机抽取 N 个互不重复的名词，
然后循环针对每个名词生成指定字数的文章。
并发度 = 同时运行的 case 数。每个 case 的进度通过轮询接口暴露给前端进度条。
"""
import asyncio
import time
from dataclasses import dataclass, field
from typing import Optional

from . import model_store
from .llm_client import chat_completion_stream, fetch_vllm_metrics
from .noun_library import pick_nouns_pool
from . import prom_snapshot
from . import workspace

# 单个 case 的状态
@dataclass
class CaseState:
    case_id: int
    status: str = "pending"  # pending/queued/running/completed/error/stopped
    total_loops: int = 0
    completed_loops: int = 0
    current_noun: str = ""
    calls_done: int = 0
    errors: int = 0
    last_error: str = ""
    error_records: list = field(default_factory=list)   # 每次错误的明细记录
    qa_history: list = field(default_factory=list)      # 每次问答的完整记录（含流式增量）
    qa_version: int = 0          # qa 结构版本号：新增/结束问答时 +1（供 SSE 判断何时重发快照）
    nouns: list = field(default_factory=list)
    chars_generated: int = 0
    started_at: float = 0.0
    finished_at: float = 0.0
    # ---- 端到端性能（客户端侧测量，仅统计流式文章调用）----
    e2e_ttft: list = field(default_factory=list)     # 每次调用的首字延迟（秒）
    e2e_tpot: list = field(default_factory=list)     # 每次调用的逐字间隔（秒/字）
    e2e_chars: int = 0                               # 流式生成总字符数
    e2e_gen_time: float = 0.0                        # 纯生成时段总和（首字后到最后字）

    def add_error(self, phase: str, error: str, *, loop: int = 0,
                  noun: str = "", duration: float = 0.0) -> None:
        """记录一次错误明细（供前端悬浮框展示）。"""
        self.errors += 1
        self.last_error = error
        self.error_records.append({
            "ts": round(time.time(), 1),   # 发生时间（epoch 秒）
            "phase": phase,                # 阶段：生成文章/内部异常
            "loop": loop,                  # 第几轮（1-based）
            "noun": noun,                  # 出错时正在写的名词
            "duration": round(duration, 1),  # 该次调用耗时（秒）
            "error": error,                # 错误信息（含异常类型）
        })

    def begin_qa(self, phase: str, *, loop: int = 0, noun: str = "",
                 question: str = "") -> dict:
        """开始一次问答：追加记录并返回引用（流式期间更新其 partial 字段）。"""
        qa = {
            "phase": phase,           # 生成文章
            "loop": loop,             # 第几轮
            "noun": noun,
            "question": question,     # 发给 LLM 的完整 prompt
            "answer": "",             # 完成后的完整回答
            "partial": "",            # 流式进行中的增量文本（完成后清空）
            "status": "generating",   # generating/done/error
            "started_at": round(time.time(), 1),
            "finished_at": 0.0,
            "duration": 0.0,
            "chars": 0,
            "error": "",
            # ---- 客户端侧 e2e 测量（流式调用）----
            "req_t0": time.time(),          # 请求发出时刻（精确）
            "first_chunk_at": 0.0,          # 首个 chunk 到达时刻
            "first_chunk_chars": 0,         # 首个 chunk 字符数
            "last_chunk_at": 0.0,           # 最近 chunk 到达时刻
            "chunk_count": 0,               # 收到的 chunk 总数
            "ttft": None,                   # 首字延迟（秒），完成时固化
            "tpot": None,                   # 逐字间隔（秒/字），完成时固化
            "throughput": None,             # 吞吐（字/秒），完成时固化
        }
        self.qa_history.append(qa)
        self.qa_version += 1
        return qa

    def end_qa(self, qa: dict, *, success: bool, answer: str = "",
               error: str = "") -> None:
        """结束一次问答：固化结果，清空 partial。"""
        qa["status"] = "done" if success else "error"
        qa["answer"] = answer
        qa["partial"] = ""
        qa["finished_at"] = round(time.time(), 1)
        qa["duration"] = round(qa["finished_at"] - qa["started_at"], 1)
        qa["chars"] = len(answer)
        if error:
            qa["error"] = error
        # ---- 客户端侧 e2e 指标固化与聚合（仅流式调用有 chunk 数据）----
        if success and qa.get("first_chunk_at"):
            first, last = qa["first_chunk_at"], qa["last_chunk_at"]
            chars = qa["chars"]
            gen_span = max(last - first, 0.0)          # 首字之后的纯生成时段
            ttft = round(first - qa["req_t0"], 3)
            # 逐字间隔：首字后生成 (chars - 首块字符数) 个字符耗时 gen_span
            tpot = (round(gen_span / max(chars - qa["first_chunk_chars"], 1), 4)
                    if gen_span > 0 else None)
            # 吞吐：全部字符 / (发出请求到最后一个字)
            throughput = round(chars / max(last - qa["req_t0"], 1e-6), 2)
            qa["ttft"], qa["tpot"], qa["throughput"] = ttft, tpot, throughput
            self.e2e_ttft.append(ttft)
            if tpot is not None:
                self.e2e_tpot.append(tpot)
            self.e2e_chars += chars
            self.e2e_gen_time += gen_span
        self.qa_version += 1

    def to_dict(self, include_qa: bool = False) -> dict:
        d = {
            "case_id": self.case_id,
            "status": self.status,
            "total_loops": self.total_loops,
            "completed_loops": self.completed_loops,
            "current_noun": self.current_noun,
            "calls_done": self.calls_done,
            "errors": self.errors,
            "last_error": self.last_error,
            "error_records": self.error_records,
            "chars_generated": self.chars_generated,
            # 用时：始终返回（SSE stats 事件不含 qa，但前端需要实时刷新用时）
            "elapsed": round(
                (self.finished_at or time.time()) - self.started_at, 1
            ) if self.started_at else 0.0,
            # 端到端性能聚合（客户端侧测量，仅统计流式文章调用）
            "e2e": {
                "samples": len(self.e2e_ttft),
                "ttft_avg_s": (round(sum(self.e2e_ttft) / len(self.e2e_ttft), 3)
                               if self.e2e_ttft else None),
                "ttft_max_s": (round(max(self.e2e_ttft), 3)
                               if self.e2e_ttft else None),
                "tpot_avg_s": (round(sum(self.e2e_tpot) / len(self.e2e_tpot), 4)
                               if self.e2e_tpot else None),
                "throughput_cps": (round(self.e2e_chars / self.e2e_gen_time, 2)
                                   if self.e2e_gen_time > 0 else None),
            },
        }
        if include_qa:
            d["qa_history"] = self.qa_history
            d["nouns"] = self.nouns
        return d


class TextTestEngine:
    """管理一次文本测试运行的所有 case。"""

    def __init__(self):
        self.test_id: Optional[str] = None
        self.params: dict = {}
        self.cases: list[CaseState] = []
        self.status: str = "idle"    # idle/running/completed/stopped/error
        self.started_at: float = 0.0
        self.finished_at: float = 0.0
        self._tasks: list[asyncio.Task] = []
        self._stop_event = asyncio.Event()
        self._model: Optional[dict] = None
        self.vllm_metrics: Optional[dict] = None    # 最新 vLLM 指标（或 {"error": ...}）
        self._metrics_task: Optional[asyncio.Task] = None
        self._token_baseline: dict = {}   # 本轮测试开始时的 counter 基线
        self._noun_pool: list = []        # 全局名词池（各 thread 取不重叠分片）
        self.task_name: str = ""          # 本轮测试任务名（workspace 目录名）

    # ---------- 启动 / 停止 ----------

    def start(self, model_id: str, noun_count: int, article_length: int,
              concurrency: int) -> dict:
        if self.status == "running":
            return {"success": False, "error": "测试已在运行中，请先停止"}
        model = model_store.get_model(model_id)
        if model is None:
            return {"success": False, "error": "模型配置不存在"}

        self._model = model
        self.params = {
            "model_id": model_id,
            "model_name": model["name"],
            "noun_count": noun_count,
            "article_length": article_length,
            "concurrency": concurrency,
        }
        self.test_id = f"txt-{int(time.time()*1000)}"
        self.task_name = workspace.new_task_name("文本测试")
        self.cases = [CaseState(case_id=i + 1) for i in range(concurrency)]
        for c in self.cases:
            c.status = "queued"
        # 全局名词池：总量 = 名词数量 × 并发度。
        #   不超过词库规模（2000）时全局互不重复，各 thread 取不重叠分片；
        #   超过时允许重复（有放回抽样），数量仍严格等于总量。
        self._noun_pool = pick_nouns_pool(noun_count * concurrency)
        self.status = "running"
        self.started_at = time.time()
        self.finished_at = 0.0
        self._stop_event = asyncio.Event()

        # 错峰启动（ramp-up）：避免所有 thread 的首个请求同时打到服务器
        #   造成 prefill 风暴。thread i 延迟 i * stagger 秒启动，
        #   stagger 随并发数自适应，总启动窗口控制在 ~10 秒。
        stagger = min(2.0, max(0.15, 10.0 / max(concurrency - 1, 1)))

        loop = asyncio.get_running_loop()
        for i, case in enumerate(self.cases):
            self._tasks.append(
                loop.create_task(self._run_case(case, start_delay=i * stagger)))
        loop.create_task(self._wait_all())
        # 后台抓取 vLLM /metrics（供 case 详情弹窗展示）
        self.vllm_metrics = None
        self._token_baseline = {}
        self._metrics_task = loop.create_task(self._poll_vllm_metrics())
        # 持久化：启动即写 config（profile + 模型快照），结束后由 _wait_all 写 result
        workspace.save_config(self.task_name, {
            "task_name": self.task_name,
            "kind": "文本测试",
            "test_id": self.test_id,
            "status": "running",
            "started_at": self.started_at,
            "params": self.params,
            "model": {
                "id": model_id,
                "name": model.get("name", ""),
                "model": model.get("model", ""),
                "url": model.get("url", ""),
            },
        })
        return {"success": True, "test_id": self.test_id, "task_name": self.task_name}

    def stop(self) -> dict:
        if self.status != "running":
            return {"success": False, "error": "当前没有运行中的测试"}
        self._stop_event.set()
        for t in self._tasks:
            t.cancel()
        self.status = "stopped"
        self.finished_at = time.time()
        for c in self.cases:
            if c.status in ("pending", "queued", "running"):
                c.status = "stopped"
                c.finished_at = time.time()
        self._tasks = []
        return {"success": True}

    # ---------- 状态查询 ----------

    def get_case(self, case_id: int) -> Optional[CaseState]:
        """获取 case 状态对象（供 SSE 流直接读取实时数据）。"""
        for c in self.cases:
            if c.case_id == case_id:
                return c
        return None

    def case_detail(self, case_id: int, include_qa: bool = True) -> Optional[dict]:
        """单个 case 的详情（含问答历史），供详情弹窗轮询。"""
        for c in self.cases:
            if c.case_id == case_id:
                return c.to_dict(include_qa=include_qa)
        return None

    def status_dict(self) -> dict:
        total_calls = sum(c.calls_done for c in self.cases)
        total_errors = sum(c.errors for c in self.cases)
        total_chars = sum(c.chars_generated for c in self.cases)
        done_cases = sum(1 for c in self.cases
                         if c.status in ("completed", "error", "stopped"))
        if self.started_at:
            elapsed = (self.finished_at or time.time()) - self.started_at
        else:
            elapsed = 0.0
        return {
            "test_id": self.test_id,
            "task_name": self.task_name,
            "status": self.status,
            "params": self.params,
            "elapsed": round(elapsed, 1),
            "summary": {
                "total_cases": len(self.cases),
                "done_cases": done_cases,
                "total_calls": total_calls,
                "total_errors": total_errors,
                "total_chars": total_chars,
            },
            "cases": [c.to_dict() for c in self.cases],
            # vLLM 服务端指标（后台每 5s 抓取一次；前端在测试状态区域展示）
            "vllm_metrics": self.vllm_metrics,
        }

    # ---------- 内部执行逻辑 ----------

    async def _wait_all(self):
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
        if self._metrics_task:
            self._metrics_task.cancel()
            self._metrics_task = None
        if self.status == "running":
            self.status = "completed"
            self.finished_at = time.time()
        # 持久化：测试结束（完成/停止/出错）后写 result（含各 case 问答历史）
        if self.task_name:
            try:
                result = self.status_dict()
                result["cases"] = [self.case_detail(c.case_id) for c in self.cases]
                workspace.save_result(self.task_name, result)
            except OSError:
                pass  # 磁盘写入失败不影响测试本身
        # 监控快照：后台拉取 Prometheus 指标存档（不阻塞结束流程；
        # 未配置 Prometheus 或拉取失败均静默，不影响测试结果）
        if self.task_name and self.started_at and self.finished_at:
            asyncio.create_task(self._snapshot_metrics())

    async def _snapshot_metrics(self):
        """测试结束后按起止时间拉取 Prometheus 指标快照。"""
        try:
            cfg = model_store.get_prometheus_config()
            url = cfg.get("url", "")
            if not url:
                return
            snap = await prom_snapshot.fetch_snapshot(
                url, self.started_at, self.finished_at)
            if snap.get("series"):
                prom_snapshot.save_metrics(self.task_name, snap)
        except Exception:
            pass  # 快照失败不影响测试结果

    async def _poll_vllm_metrics(self):
        """后台每 5 秒抓取一次 vLLM /metrics 主要指标。失败时记录错误信息。"""
        api_key = model_store.decode_key(self._model.get("api_key", ""))
        last_sample: Optional[tuple] = None  # (采样时刻, generation_tokens_total)
        while self.status == "running":
            r = await fetch_vllm_metrics(self._model["url"], api_key=api_key)
            if r["success"]:
                m = r["metrics"]
                now = time.time()
                # 新版 vLLM 移除了吞吐 gauge：
                # 用 generation_tokens_total 两次采样的差分计算 tok/s
                if m.get("gen_throughput_toks") is None:
                    gt = m.get("generation_tokens_total")
                    if (last_sample is not None and gt is not None
                            and last_sample[1] is not None
                            and now > last_sample[0]):
                        dt = now - last_sample[0]
                        m["gen_throughput_toks"] = round(
                            (gt - last_sample[1]) / dt, 1)
                    last_sample = (now, gt)
                # prompt/generation_tokens_total 是 vLLM 服务启动起累加的
                # counter（跨测试轮次不归零）：扣除本轮首次采样时的基线，
                # 得到"本轮测试"的累计值。若当前值小于基线，说明 vLLM
                # 中途重启 counter 归零，重新校准基线。
                for k in ("prompt_tokens_total", "generation_tokens_total"):
                    cur = m.get(k)
                    if cur is None:
                        continue
                    base = self._token_baseline.get(k)
                    if base is None or cur < base:
                        self._token_baseline[k] = cur
                        base = cur
                    m[k] = cur - base
                self.vllm_metrics = m
            else:
                self.vllm_metrics = {"error": r["error"]}
            try:
                # 可中断的 sleep：用户停止测试时立即退出
                await asyncio.wait_for(self._stop_event.wait(), timeout=5.0)
                break
            except asyncio.TimeoutError:
                continue

    async def _wait_rampup(self, case: CaseState, delay: float) -> bool:
        """错峰启动等待。返回 False 表示测试已被停止。

        等待期间每 0.5s 检查一次 vLLM 排队情况：若 waiting_requests
        超过并发数的一半（服务器已过载排队），自动顺延启动，
        顺延上限 30 秒，避免无限等待。指标不可用时仅按固定错峰执行。
        """
        deadline = time.monotonic() + delay
        hard_deadline = deadline + 30.0  # 队列顺延上限
        threshold = max(2, len(self.cases) // 2)
        while True:
            now = time.monotonic()
            if now >= deadline:
                return True
            m = self.vllm_metrics
            if isinstance(m, dict):
                waiting = m.get("waiting_requests")
                if waiting is not None and waiting > threshold and now < hard_deadline:
                    deadline = min(deadline + 0.5, hard_deadline)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=0.5)
                return False
            except asyncio.TimeoutError:
                continue

    async def _run_case(self, case: CaseState, start_delay: float = 0.0):
        model = self._model
        api_key = model_store.decode_key(model.get("api_key", ""))
        if start_delay > 0:
            if not await self._wait_rampup(case, start_delay):
                return  # 已被用户停止
        case.status = "running"
        case.started_at = time.time()
        try:
            # 第一步：从全局名词池取本 thread 的分片
            #   池在 start() 时按 名词数量 × 并发度 全局抽取：
            #   总量 <= 2000 时全局互不重复，各 thread 分片不重叠；
            #   超过 2000 时允许重复。
            n = self.params["noun_count"]
            base = (case.case_id - 1) * n
            nouns = self._noun_pool[base:base + n]
            case.nouns = nouns
            case.total_loops = len(nouns)

            # 第二步：循环生成文章
            for i, noun in enumerate(nouns):
                if self._stop_event.is_set():
                    case.status = "stopped"
                    case.finished_at = time.time()
                    return
                case.current_noun = noun
                case.completed_loops = i
                prompt = (f'围绕"{noun}"写一篇{self.params["article_length"]}字的文章。'
                          f'直接输出文章正文。')
                # 流式生成：on_chunk 实时更新 qa["partial"]，
                # 前端详情弹窗轮询时即可看到"LLM 正在回复"的流式效果
                qa = case.begin_qa("生成文章", loop=i + 1, noun=noun,
                                   question=prompt)

                def _on_chunk(delta: str, _qa=qa) -> None:
                    now = time.time()
                    if not _qa["first_chunk_at"]:
                        _qa["first_chunk_at"] = now
                        _qa["first_chunk_chars"] = len(delta)
                    _qa["last_chunk_at"] = now
                    _qa["chunk_count"] += 1
                    _qa["partial"] += delta

                r = await chat_completion_stream(
                    base_url=model["url"], model=model["model"],
                    messages=[{"role": "user", "content": prompt}],
                    api_key=api_key,
                    max_tokens=max(2048, self.params["article_length"] * 2),
                    timeout=600.0,
                    on_chunk=_on_chunk,
                )
                case.calls_done += 1
                if r["success"]:
                    case.chars_generated += len(r["content"])
                    case.end_qa(qa, success=True, answer=r["content"])
                else:
                    case.end_qa(qa, success=False, error=r["error"])
                    case.add_error("生成文章", r["error"],
                                   loop=i + 1, noun=noun,
                                   duration=time.time() - qa["started_at"])
            case.completed_loops = case.total_loops
            case.current_noun = ""
            # 有错误也标记完成（错误通过 errors 计数与 last_error 传递，
            # 前端在 errors > 0 时会展示 last_error 供诊断）
            case.status = "completed"
            case.finished_at = time.time()
        except asyncio.CancelledError:
            if case.status not in ("completed", "error"):
                case.status = "stopped"
                case.finished_at = time.time()
        except Exception as e:
            case.add_error("内部异常", f"{type(e).__name__}: {e}")
            case.status = "error"
            case.finished_at = time.time()



# 全局单例（文本测试）
text_engine = TextTestEngine()
