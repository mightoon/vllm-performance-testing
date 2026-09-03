"""视频（视频理解）测试执行引擎。

与图形测试（image_engine.py）同构：并发度 = 同时运行的 case 数，
每个 case 循环处理分到的视频——把视频（base64 多模态消息）发给
被测模型，要求其理解视频内容并按指定字数生成一篇文章。

视频池：启动时扫描用户选择的目录（按文件名排序保证稳定），
总量 = 迭代次数 × 并发度，全局 round-robin 循环取视频（目录视频
不够用时重复使用），各 thread 取不重叠分片。

输入 token 统计：请求带 stream_options.include_usage 从响应取
每请求精确 prompt_tokens（vLLM 0.5+ 支持）；取不到时该次调用
记 None，任务级平均值回退用 vLLM /metrics 的本轮 tokens 差分估算。
"""
import asyncio
import base64
import os
import time
from dataclasses import dataclass, field
from typing import Optional

from . import model_store
from .llm_client import chat_completion_stream, fetch_vllm_metrics
from . import analysis
from . import applog
from . import prom_snapshot
from . import workspace

# 支持的视频扩展名（vLLM 视频模型常规支持集）
VIDEO_EXTS = {".mp4", ".avi", ".mkv", ".mov", ".webm",
              ".flv", ".wmv", ".m4v", ".mpg", ".mpeg"}

# 扩展名 -> data URL 的 MIME 类型
_MIME = {
    ".mp4": "video/mp4",
    ".m4v": "video/x-m4v",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".flv": "video/x-flv",
    ".wmv": "video/x-ms-wmv",
    ".mpg": "video/mpeg", ".mpeg": "video/mpeg",
}


def scan_video_dir(video_dir: str) -> list[str]:
    """扫描目录下的全部视频文件（按文件名排序，保证池分配稳定）。

    不递归子目录。目录不存在或无权限时抛 OSError，由调用方处理。
    """
    files = []
    with os.scandir(video_dir) as it:
        for entry in it:
            if entry.is_file() and os.path.splitext(entry.name)[1].lower() in VIDEO_EXTS:
                files.append(entry.name)
    files.sort()
    return files


def build_video_prompt(output_tokens: int) -> str:
    """视频测试 prompt：理解视频 + 按输出长度生成文章。

    output_tokens 为目标输出 token 数，按 ~1.7 字/token 折算为字数
    写入指令（与文本/图形测试口径一致，模型对「字数」遵循更好）。
    """
    n_chars = max(20, round(output_tokens * 1.7))
    return (f"请仔细观看这段视频，理解视频的内容与细节，"
            f"然后写一篇约{n_chars}字的文章。文章应围绕视频中的"
            f"主体、场景与情节展开，写作时请严格遵循该字数要求，"
            f"直接输出文章正文。")


def _read_video_data_url(path: str) -> str:
    """读视频文件并编码为 data URL（base64）。"""
    ext = os.path.splitext(path)[1].lower()
    mime = _MIME.get(ext, "video/mp4")
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{b64}"


# 单个 case 的状态（与图形测试 CaseState 同构，名词 → 视频文件名）
@dataclass
class CaseState:
    case_id: int
    status: str = "pending"  # pending/queued/running/completed/error/stopped
    total_loops: int = 0
    completed_loops: int = 0
    current_video: str = ""
    calls_done: int = 0
    errors: int = 0
    last_error: str = ""
    error_records: list = field(default_factory=list)   # 每次错误的明细记录
    qa_history: list = field(default_factory=list)      # 每次调用的完整记录（含流式增量）
    qa_version: int = 0          # qa 结构版本号：新增/结束问答时 +1（供 SSE 判断何时重发快照）
    videos: list = field(default_factory=list)          # 本 thread 分到的视频文件名列表
    chars_generated: int = 0
    started_at: float = 0.0
    finished_at: float = 0.0
    # ---- 端到端性能（客户端侧测量，仅统计流式文章调用）----
    e2e_ttft: list = field(default_factory=list)     # 每次调用的首字延迟（秒）
    e2e_tpot: list = field(default_factory=list)     # 每次调用的逐字间隔（秒/字）
    e2e_chars: int = 0                               # 流式生成总字符数
    e2e_gen_time: float = 0.0                        # 纯生成时段总和（首字后到最后字）
    # ---- 输入 token（API usage 实测，include_usage 不可用时为空）----
    prompt_tokens_list: list = field(default_factory=list)  # 每次成功调用的 prompt_tokens

    def add_error(self, phase: str, error: str, *, loop: int = 0,
                  video: str = "", duration: float = 0.0) -> None:
        """记录一次错误明细（供前端悬浮框展示）。"""
        self.errors += 1
        self.last_error = error
        self.error_records.append({
            "ts": round(time.time(), 1),   # 发生时间（epoch 秒）
            "phase": phase,                # 阶段：生成文章/读取视频/内部异常
            "loop": loop,                  # 第几轮（1-based）
            "video": video,                # 出错时正在处理的视频文件名
            "duration": round(duration, 1),  # 该次调用耗时（秒）
            "error": error,                # 错误信息（含异常类型）
        })

    def begin_qa(self, phase: str, *, loop: int = 0, video: str = "",
                 question: str = "") -> dict:
        """开始一次调用：追加记录并返回引用（流式期间更新其 partial 字段）。"""
        qa = {
            "phase": phase,           # 生成文章
            "loop": loop,             # 第几轮
            "video": video,           # 本次处理的视频文件名（仅存名不存视频，控制体积）
            "question": question,     # 发给 LLM 的文本 prompt（视频测试 prompt 很短，全文存储）
            "answer": "",             # 完成后的完整回答
            "partial": "",            # 流式进行中的增量文本（完成后清空）
            "status": "generating",   # generating/done/error
            "started_at": round(time.time(), 1),
            "finished_at": 0.0,
            "duration": 0.0,
            "chars": 0,
            "error": "",
            "prompt_tokens": None,    # 该次调用实测输入 token（usage 不可用时为 None）
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
               error: str = "", prompt_tokens: Optional[int] = None) -> None:
        """结束一次调用：固化结果，清空 partial。"""
        qa["status"] = "done" if success else "error"
        qa["answer"] = answer
        qa["partial"] = ""
        qa["finished_at"] = round(time.time(), 1)
        qa["duration"] = round(qa["finished_at"] - qa["started_at"], 1)
        qa["chars"] = len(answer)
        qa["prompt_tokens"] = prompt_tokens
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
        if success and prompt_tokens is not None:
            self.prompt_tokens_list.append(prompt_tokens)
        self.qa_version += 1

    def to_dict(self, include_qa: bool = False) -> dict:
        d = {
            "case_id": self.case_id,
            "status": self.status,
            "total_loops": self.total_loops,
            "completed_loops": self.completed_loops,
            "current_video": self.current_video,
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
            # 输入 token 平均（API usage 实测；无样本时为 None → 前端显示 —）
            "prompt_tokens_avg": (round(sum(self.prompt_tokens_list)
                                        / len(self.prompt_tokens_list))
                                  if self.prompt_tokens_list else None),
        }
        if include_qa:
            d["qa_history"] = self.qa_history
            d["videos"] = self.videos
        return d


class VideoTestEngine:
    """管理一次视频测试运行的所有 case。"""

    def __init__(self):
        self.test_id: Optional[str] = None
        self.params: dict = {}
        self.cases: list[CaseState] = []
        self.status: str = "idle"    # idle/running/completed/stopped/error
        self.started_at: float = 0.0
        self.finished_at: float = 0.0
        self._tasks: list[asyncio.Task] = []
        self._stop_event: asyncio.Event()
        self._model: Optional[dict] = None
        self.vllm_metrics: Optional[dict] = None    # 最新 vLLM 指标（或 {"error": ...}）
        self._metrics_task: Optional[asyncio.Task] = None
        self._counter_baseline: dict = {}  # 本轮测试开始时的 counter 基线
        self._metrics_stats: dict = {}    # 整轮指标统计累加器（峰值/均值，供报告模式）
        self._last_gt_sample: Optional[tuple] = None  # (采样时刻, generation_tokens_total)，吞吐差分用
        self._video_pool: list[str] = []  # 全局视频池（各 thread 取不重叠分片，存绝对路径）
        self.task_name: str = ""          # 本轮测试任务名（workspace 目录名）

    # ---------- 启动 / 停止 ----------

    def start(self, model_id: str, video_dir: str, video_count: int,
              article_length: int, concurrency: int,
              probe: dict | None = None) -> dict:
        if self.status == "running":
            return {"success": False, "error": "测试已在运行中，请先停止"}
        model = model_store.get_model(model_id)
        if model is None:
            return {"success": False, "error": "模型配置不存在"}

        # 扫描视频目录（不存在/无权限时 scandir 抛 OSError）
        try:
            video_names = scan_video_dir(video_dir)
        except OSError as e:
            return {"success": False,
                    "error": f"无法读取视频目录：{e}"}
        if not video_names:
            return {"success": False,
                    "error": f"目录中没有视频文件（支持 {'/'.join(sorted(VIDEO_EXTS))}）"}

        self._model = model
        self.params = {
            "model_id": model_id,
            "model_name": model["name"],
            "video_dir": video_dir,
            "video_count": video_count,
            "article_length": article_length,
            "concurrency": concurrency,
            # 目录内视频总数（报告 Profile 展示；池不够用时前端可提示重复使用）
            "video_pool_size": len(video_names),
        }
        self.test_id = f"vid-{int(time.time()*1000)}"
        self.task_name = workspace.new_task_name("视频测试")
        self.cases = [CaseState(case_id=i + 1) for i in range(concurrency)]
        for c in self.cases:
            c.status = "queued"
        # 全局视频池：总量 = 迭代次数 × 并发度，round-robin 循环取视频
        #   （目录视频不够用时重复使用），各 thread 取不重叠分片
        total = video_count * concurrency
        self._video_pool = [os.path.join(video_dir, video_names[i % len(video_names)])
                            for i in range(total)]
        self.status = "running"
        self.started_at = time.time()
        self.finished_at = 0.0
        self._stop_event = asyncio.Event()

        # 错峰启动（ramp-up）：避免所有 thread 的首个请求同时打到服务器
        #   造成 prefill 风暴（视频 prefill 开销远大于图片，错峰更有意义）。
        #   thread i 延迟 i * stagger 秒启动，总启动窗口控制在 ~10 秒
        stagger = min(2.0, max(0.15, 10.0 / max(concurrency - 1, 1)))

        loop = asyncio.get_running_loop()
        for i, case in enumerate(self.cases):
            self._tasks.append(
                loop.create_task(self._run_case(case, start_delay=i * stagger)))
        loop.create_task(self._wait_all())
        # 后台抓取 vLLM /metrics（供 case 详情弹窗展示）
        self.vllm_metrics = None
        self._counter_baseline = {}
        self._metrics_stats = {}
        self._last_gt_sample = None
        self._metrics_task = loop.create_task(self._poll_vllm_metrics())
        # 持久化：启动即写 config（profile + 模型快照），结束后由 _wait_all 写 result
        workspace.save_config(self.task_name, {
            "task_name": self.task_name,
            "kind": "视频测试",
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
            # 启动时刻的服务端参数快照（报告模式 Profile 区域数据源）
            "model_probe": probe,
        })
        applog.log("test", f"启动视频测试 {self.task_name} "
                   f"model={self._model.get('name')} params={self.params}")
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
        applog.log("test", f"用户停止视频测试 {self.task_name}")
        return {"success": True}

    # ---------- 状态查询 ----------

    def get_case(self, case_id: int) -> Optional[CaseState]:
        """获取 case 状态对象（供 SSE 流直接读取实时数据）。"""
        for c in self.cases:
            if c.case_id == case_id:
                return c
        return None

    def case_detail(self, case_id: int, include_qa: bool = True) -> Optional[dict]:
        """单个 case 的详情（含调用历史），供详情弹窗轮询。"""
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
        # 输入 token 平均：优先 API usage 实测（各 case 样本合并）；
        # 无样本（服务不支持 include_usage）时回退 /metrics 差分估算
        tokens = [t for c in self.cases for t in c.prompt_tokens_list]
        if tokens:
            prompt_tokens_avg = round(sum(tokens) / len(tokens))
            tokens_source = "usage"
        else:
            m = self.vllm_metrics if isinstance(self.vllm_metrics, dict) else {}
            pt = m.get("prompt_tokens_total")
            prompt_tokens_avg = (round(pt / total_calls) if pt and total_calls else None)
            tokens_source = "metrics"
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
                "prompt_tokens_avg": prompt_tokens_avg,
                "prompt_tokens_source": tokens_source,
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
        # 最终指标抓取：轮询间隔最多滞后 5s，结束时补一次采样，
        # 让报告的终值差分（TTFT/TPOT 均值、命中率、抢占数、tokens）
        # 覆盖到最后一批完成的请求。失败则沿用最后一次轮询快照。
        if self._model:
            try:
                api_key = model_store.decode_key(self._model.get("api_key", ""))
                r = await fetch_vllm_metrics(self._model["url"], api_key=api_key)
                if r["success"]:
                    self._apply_metrics_sample(r)
            except Exception:
                pass  # 最终抓取失败不影响测试结果
        # 持久化：测试结束（完成/停止/出错）后写 result（含各 case 调用历史）
        if self.task_name:
            try:
                result = self.status_dict()
                result["cases"] = [self.case_detail(c.case_id) for c in self.cases]
                # 整轮 vLLM 指标统计（报告模式展示；区别于最后一次实时快照）
                result["vllm_metrics_summary"] = self._vllm_metrics_summary()
                workspace.save_result(self.task_name, result)
                applog.log("test", f"视频测试结束 {self.task_name} status={self.status} "
                           f"耗时={self.finished_at - self.started_at:.0f}s "
                           f"cases={len(self.cases)} result.json 已保存")
            except OSError:
                pass  # 磁盘写入失败不影响测试本身
        # 监控快照 + AI 分析：均后台执行，不阻塞结束流程。
        # 分析等快照落盘后再跑（输入含 Prometheus 统计）；
        # 未配置 Prometheus / 模型调用失败均静默，不影响测试结果
        if self.task_name and self.started_at and self.finished_at:
            snap_task = asyncio.create_task(self._snapshot_metrics())
            asyncio.create_task(analysis.run_and_save(self.task_name, snap_task))
            applog.log("test", f"后台任务已派发 {self.task_name}: 监控快照 + AI 分析")

    async def _snapshot_metrics(self):
        """测试结束后按起止时间拉取 Prometheus 指标快照。"""
        try:
            cfg = model_store.get_prometheus_config()
            url = cfg.get("url", "")
            if not url:
                applog.log("metrics", f"快照跳过 {self.task_name}: 未配置 Prometheus")
                return
            snap = await prom_snapshot.fetch_snapshot(
                url, self.started_at, self.finished_at)
            if snap.get("series"):
                prom_snapshot.save_metrics(self.task_name, snap)
                applog.log("metrics", f"快照已保存 {self.task_name}/metrics.json "
                           f"series={len(snap['series'])}")
            else:
                applog.log("metrics", f"快照无数据 {self.task_name} "
                           f"(series=0, range={self.started_at:.0f}~{self.finished_at:.0f})")
        except Exception as e:
            applog.log("metrics", f"快照失败 {self.task_name} "
                       f"error={type(e).__name__}: {e}")

    async def _poll_vllm_metrics(self):
        """后台每 5 秒抓取一次 vLLM /metrics 主要指标。失败时记录错误信息。"""
        try:
            api_key = model_store.decode_key(self._model.get("api_key", ""))
            while self.status == "running":
                try:
                    r = await fetch_vllm_metrics(self._model["url"], api_key=api_key)
                    if r["success"]:
                        self._apply_metrics_sample(r)
                    else:
                        self.vllm_metrics = {"error": r["error"]}
                        applog.log("metrics", f"轮询失败 {self.task_name} "
                                   f"error={r['error']}")
                except Exception as e:
                    self.vllm_metrics = {"error": "vLLM 指标抓取异常"}
                    applog.log("metrics", f"轮询异常 {self.task_name} "
                               f"error={type(e).__name__}: {e}")
                try:
                    # 可中断的 sleep：用户停止测试时立即退出
                    await asyncio.wait_for(self._stop_event.wait(), timeout=5.0)
                    break
                except asyncio.TimeoutError:
                    continue
        except asyncio.CancelledError:
            pass

    def _apply_metrics_sample(self, r: dict) -> None:
        """处理一次成功的 /metrics 采样（轮询与测试结束时最终抓取共用）：
        counter 基线差分、重算本轮均值/命中率、累计整轮统计、更新实时快照。"""
        m = r["metrics"]
        now = time.time()
        # 新版 vLLM 移除了吞吐 gauge：
        # 用 generation_tokens_total 两次采样的差分计算 tok/s
        if m.get("gen_throughput_toks") is None:
            gt = m.get("generation_tokens_total")
            ls = self._last_gt_sample
            if (ls is not None and gt is not None
                    and ls[1] is not None
                    and now > ls[0]):
                dt = now - ls[0]
                m["gen_throughput_toks"] = round(
                    (gt - ls[1]) / dt, 1)
            self._last_gt_sample = (now, gt)
        # 以下均为 vLLM 服务启动起累加的 counter（跨测试轮次
        # 不归零）：扣除本轮首次采样时的基线，得到"本轮测试"
        # 的值。若当前值小于基线，说明 vLLM 中途重启 counter
        # 归零，重新校准基线。
        for k in ("prompt_tokens_total", "generation_tokens_total",
                  "ttft_sum", "ttft_cnt", "tpot_sum", "tpot_cnt",
                  "prefill_sum", "prefill_cnt", "decode_sum", "decode_cnt",
                  "e2e_sum", "e2e_cnt",
                  "pc_hits", "pc_queries", "preemptions_total"):
            cur = m.get(k)
            if cur is None:
                continue
            base = self._counter_baseline.get(k)
            if base is None or cur < base:
                self._counter_baseline[k] = cur
                base = cur
            m[k] = cur - base
        # TTFT/TPOT/prefill/decode/前缀缓存命中：sum/count 同为累计
        # counter，用扣除基线后的差分重算"本轮"均值/命中率，避免被
        # 之前测试轮次的负载污染（本轮尚无完成请求时为 None）
        if m.get("ttft_sum") is not None and m.get("ttft_cnt") is not None:
            m["ttft_avg_s"] = (round(m["ttft_sum"] / m["ttft_cnt"], 3)
                               if m["ttft_cnt"] > 0 else None)
        if m.get("tpot_sum") is not None and m.get("tpot_cnt") is not None:
            m["tpot_avg_s"] = (round(m["tpot_sum"] / m["tpot_cnt"], 3)
                               if m["tpot_cnt"] > 0 else None)
        if (m.get("prefill_sum") is not None
                and m.get("prefill_cnt") is not None):
            m["prefill_avg_s"] = (round(m["prefill_sum"] / m["prefill_cnt"], 3)
                                  if m["prefill_cnt"] > 0 else None)
        if (m.get("decode_sum") is not None
                and m.get("decode_cnt") is not None):
            m["decode_avg_s"] = (round(m["decode_sum"] / m["decode_cnt"], 3)
                                 if m["decode_cnt"] > 0 else None)
        if m.get("e2e_sum") is not None and m.get("e2e_cnt") is not None:
            m["e2e_avg_s"] = (round(m["e2e_sum"] / m["e2e_cnt"], 3)
                              if m["e2e_cnt"] > 0 else None)
        if m.get("pc_hits") is not None and m.get("pc_queries") is not None:
            m["prefix_cache_hit_rate"] = (
                round(m["pc_hits"] / m["pc_queries"], 4)
                if m["pc_queries"] > 0 else None)
        self._accumulate_metrics_stats(m)
        self.vllm_metrics = m

    def _accumulate_metrics_stats(self, m: dict):
        """累计整轮测试的 vLLM 指标统计（供报告模式展示）。

        请求类指标记峰值；吞吐/KV 占用等 gauge 累加求时间平均；
        TTFT/TPOT/命中率的采样点累计均值仅作终值缺失时的回退
        （报告主口径是最后一次快照的 counter 差分）。
        """
        st = self._metrics_stats
        st["samples"] = st.get("samples", 0) + 1
        for k in ("running_requests", "waiting_requests"):
            v = m.get(k)
            if v is not None:
                key = k + "_max"
                if st.get(key) is None or v > st[key]:
                    st[key] = v
        for k in ("gen_throughput_toks", "gpu_cache_usage",
                  "prefix_cache_hit_rate", "ttft_avg_s", "tpot_avg_s",
                  "prefill_avg_s", "decode_avg_s", "e2e_avg_s"):
            v = m.get(k)
            if v is not None:
                st[k + "_sum"] = st.get(k + "_sum", 0.0) + v
                st[k + "_n"] = st.get(k + "_n", 0) + 1

    def _vllm_metrics_summary(self) -> Optional[dict]:
        """汇总整轮测试的 vLLM 指标：请求峰值 + 吞吐/缓存均值 + 终值差分。

        均值类（TTFT/TPOT/前缀缓存命中率）取最后一次快照的 counter
        差分之比（请求等权真均值）；吞吐/KV 占用为 gauge，取采样点
        时间平均。无有效采样（全部采集失败）时返回 None。
        """
        st = self._metrics_stats
        if not st.get("samples"):
            return None

        def avg(key: str, digits: int) -> Optional[float]:
            n = st.get(key + "_n", 0)
            return round(st[key + "_sum"] / n, digits) if n else None

        m = self.vllm_metrics if isinstance(self.vllm_metrics, dict) else {}

        def final_ratio(num_key: str, den_key: str, digits: int,
                        fallback_key: str) -> Optional[float]:
            """终值差分比率（请求等权），终值缺失时回退采样点平均。"""
            num, den = m.get(num_key), m.get(den_key)
            if num is not None and den:
                return round(num / den, digits)
            return avg(fallback_key, digits)

        return {
            "samples": st["samples"],
            "running_requests_max": st.get("running_requests_max"),
            "waiting_requests_max": st.get("waiting_requests_max"),
            "gen_throughput_toks_avg": avg("gen_throughput_toks", 1),
            "gpu_cache_usage_avg": avg("gpu_cache_usage", 4),
            "prefix_cache_hit_rate_avg": final_ratio(
                "pc_hits", "pc_queries", 4, "prefix_cache_hit_rate"),
            "ttft_avg_s": final_ratio(
                "ttft_sum", "ttft_cnt", 3, "ttft_avg_s"),
            "tpot_avg_s": final_ratio(
                "tpot_sum", "tpot_cnt", 3, "tpot_avg_s"),
            "prefill_avg_s": final_ratio(
                "prefill_sum", "prefill_cnt", 3, "prefill_avg_s"),
            "decode_avg_s": final_ratio(
                "decode_sum", "decode_cnt", 3, "decode_avg_s"),
            "e2e_avg_s": final_ratio(
                "e2e_sum", "e2e_cnt", 3, "e2e_avg_s"),
            "prompt_tokens_total": m.get("prompt_tokens_total"),
            "generation_tokens_total": m.get("generation_tokens_total"),
            "preemptions_total": m.get("preemptions_total"),
        }

    async def _wait_rampup(self, case: CaseState, delay: float) -> bool:
        """错峰启动等待。返回 False 表示测试已被停止。

        等待期间每 0.5s 检查一次 vLLM 排队情况：若 waiting_requests
        超过并发数的一半（服务器已过载排队），自动顺延启动，
        顺延上限 30 秒。指标不可用时仅按固定错峰执行。
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
            # 第一步：从全局视频池取本 thread 的分片
            #   池在 start() 时按 迭代次数 × 并发度 round-robin 生成：
            #   目录视频够用时各 thread 分片不重叠，不够时循环重复
            n = self.params["video_count"]
            base = (case.case_id - 1) * n
            video_paths = self._video_pool[base:base + n]
            case.videos = [os.path.basename(p) for p in video_paths]
            case.total_loops = len(video_paths)

            # 第二步：循环处理视频
            for i, path in enumerate(video_paths):
                if self._stop_event.is_set():
                    case.status = "stopped"
                    case.finished_at = time.time()
                    return
                video_name = os.path.basename(path)
                case.current_video = video_name
                case.completed_loops = i
                prompt = build_video_prompt(self.params["article_length"])
                # 多模态消息：视频（data URL）+ 文本指令（OpenAI 标准格式）
                try:
                    # 本地读视频 + base64 编码放线程池，避免大视频高并发时
                    # 阻塞事件循环（SSE 推送/指标轮询都跑在同一循环上）
                    data_url = await asyncio.to_thread(_read_video_data_url, path)
                except OSError as e:
                    case.calls_done += 1
                    case.add_error("读取视频", f"无法读取视频文件: {e}",
                                   loop=i + 1, video=video_name)
                    continue
                messages = [{
                    "role": "user",
                    "content": [
                        {"type": "video_url",
                         "video_url": {"url": data_url}},
                        {"type": "text", "text": prompt},
                    ],
                }]
                # 流式生成：on_chunk 实时更新 qa["partial"]，
                # 前端详情弹窗轮询时即可看到"LLM 正在回复"的流式效果
                qa = case.begin_qa("生成文章", loop=i + 1, video=video_name,
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
                    messages=messages,
                    api_key=api_key,
                    # article_length 单位为 token：上限留 50% 余量，
                    # 防止模型略微超出目标字数时被 max_tokens 截断
                    max_tokens=max(2048, int(self.params["article_length"] * 1.5)),
                    # 视频 prefill（多帧视觉编码）远重于图片，超时放宽到 15 分钟
                    timeout=900.0,
                    on_chunk=_on_chunk,
                    # 每请求精确输入 token（视频 token 数只能由服务端
                    # 统计；老版本 vLLM 不支持时自动回退 metrics 差分）
                    include_usage=True,
                )
                case.calls_done += 1
                if r["success"]:
                    case.chars_generated += len(r["content"])
                    usage = r.get("usage") or {}
                    pt = usage.get("prompt_tokens")
                    case.end_qa(qa, success=True, answer=r["content"],
                                prompt_tokens=pt)
                else:
                    case.end_qa(qa, success=False, error=r["error"])
                    case.add_error("生成文章", r["error"],
                                   loop=i + 1, video=video_name,
                                   duration=time.time() - qa["started_at"])
            case.completed_loops = case.total_loops
            case.current_video = ""
            # 有错误也标记完成（错误通过 errors 计数与 last_error 传递，
            # 前端在 errors > 0 时会展示 last_error 供诊断）
            case.status = "completed"
            case.finished_at = time.time()
            applog.log("test", f"case{case.case_id} 完成 {self.task_name} "
                       f"loops={case.total_loops} errors={case.errors} "
                       f"calls={case.calls_done}")
        except asyncio.CancelledError:
            if case.status not in ("completed", "error"):
                case.status = "stopped"
                case.finished_at = time.time()
        except Exception as e:
            case.add_error("内部异常", f"{type(e).__name__}: {e}")
            case.status = "error"
            case.finished_at = time.time()
            applog.log("test", f"case{case.case_id} 异常 {self.task_name} "
                       f"error={type(e).__name__}: {e}")


# 全局单例（视频测试）
video_engine = VideoTestEngine()
