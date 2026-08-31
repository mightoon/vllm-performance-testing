# LLM 性能测试平台 · 设计文档

> 本文档基于对项目全部源码（`app/` 下 7 个 Python 模块、前端 `index.html`/`app.js`/`style.css`）及 `doc/` 下三份分析文档的逐行阅读整理而成，重点覆盖架构、模块能力、前后端交互协议与**指标计算细节**。

---

## 目录

1. [系统概述](#1-系统概述)
2. [总体架构](#2-总体架构)
3. [目录结构](#3-目录结构)
4. [后端模块设计](#4-后端模块设计)
5. [前端设计](#5-前端设计)
6. [指标体系详解（核心）](#6-指标体系详解核心)
7. [数据持久化设计](#7-数据持久化设计)
8. [API 接口清单](#8-api-接口清单)
9. [关键设计决策与权衡](#9-关键设计决策与权衡)

---

## 1. 系统概述

本项目是一个面向 **vLLM（OpenAI 兼容接口）** 的大模型性能测试平台，采用 **FastAPI 后端 + 原生 HTML/JS/ECharts 前端** 的单进程架构，无数据库依赖，全部状态持久化到本地文件系统。

核心能力：

| 能力 | 说明 |
|---|---|
| 模型配置管理 | 多个模型服务（name/model/base_url/api_key）的增删改查、连接验证；API Key base64 持久化 |
| 文本压力测试 | 从 2000 词本地名词库随机抽词，按"名词数 × 并发度"构造请求矩阵，流式生成指定字数文章 |
| 实时监控 | 测试期间每 5s 轮询 vLLM `/metrics`；case 详情通过 SSE 推送流式增量 |
| 三套指标体系 | 客户端 e2e 测量 / vLLM 服务端 counter 差分 / Prometheus 时序快照，互相印证 |
| 历史与报告 | 每轮测试落盘 `workspace/<任务名>/`，报告模式回放配置、结果、监控图表 |
| Prometheus 集成 | 测试结束按起止时间拉取 7 条 PromQL 时序存档，报告模式三级回退加载 |

测试模型：**并发度 = 同时运行的 case（线程）数**；每个 case 依次对其分到的 N 个名词各生成一篇文章。总请求数 = 名词数 × 并发度。

---

## 2. 总体架构

```
┌─────────────────────────── 浏览器（单页应用）───────────────────────────┐
│  index.html + app.js + style.css + echarts.min.js + marked.min.js      │
│                                                                        │
│  ┌──────────┐  轮询 /status (2s)   ┌──────────────┐  SSE /stream      │
│  │ 测试面板  │ ──────────────────▶ │ case 详情弹窗 │ ◀──────────────   │
│  └──────────┘                     └──────────────┘                    │
│  ┌──────────┐  REST                ┌──────────────┐                    │
│  │ 模型管理  │ ──────────────────▶ │ 报告模式/图表 │                    │
│  └──────────┘                     └──────────────┘                    │
└───────────────┬────────────────────────────────────────────────────────┘
                │ HTTP (REST + SSE)
┌───────────────▼────────────────────────────────────────────────────────┐
│                      FastAPI 单进程 (app/main.py)                       │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────┐ ┌──────────────┐  │
│  │ model_store │ │ test_engine  │ │ prom_snapshot │ │  workspace   │  │
│  │  配置持久化  │ │  测试引擎     │ │  Prom 快照    │ │  任务持久化   │  │
│  └─────────────┘ └──────┬───────┘ └───────┬───────┘ └──────────────┘  │
│                         │ llm_client      │                            │
│                  ┌──────▼───────────────┐  │                            │
│                  │ httpx AsyncClient 池 │  │ httpx AsyncClient          │
│                  │ (keep-alive 复用)     │  │                            │
│                  └──────┬───────┬───────┘  │                            │
└─────────────────────────┼───────┼──────────┼────────────────────────────┘
                          │       │          │
             ┌────────────▼─┐ ┌───▼────────┐ ┌▼──────────────┐
             │ vLLM/OpenAI  │ │ vLLM       │ │ Prometheus    │
             │ /v1/chat/    │ │ /metrics   │ │ /api/v1/      │
             │ completions  │ │ (文本格式)  │ │ query_range   │
             └──────────────┘ └────────────┘ └───────────────┘
```

关键架构特征：

- **单例引擎**：`test_engine.text_engine` 全局单例，同一时刻只允许一轮测试（running 时 start 被拒）。
- **全异步**：case 任务、指标轮询、SSE 推送均为 asyncio Task；停止通过 `asyncio.Event` 广播。
- **无数据库**：模型配置存 `config.json`，测试数据存 `workspace/` 目录，Prometheus 快照存 `metrics.json`。
- **监控与测试解耦**：vLLM 指标抓取失败只记录错误信息，不影响测试本身；Prometheus 快照失败静默跳过。

---

## 3. 目录结构

```
cb_vLLM_testing/
├── app/
│   ├── main.py            # FastAPI 入口：全部 REST/SSE 路由 + 静态文件挂载
│   ├── model_store.py     # 模型配置持久化（config.json，base64 API Key）
│   ├── llm_client.py      # OpenAI 兼容客户端：连接池/流式/vLLM 指标抓取解析
│   ├── test_engine.py     # 测试引擎：case 调度、e2e 测量、指标差分与拟合
│   ├── noun_library.py    # 本地名词库（2000 词）+ 抽样函数
│   ├── prom_snapshot.py   # Prometheus query_range 快照拉取与统计
│   ├── workspace.py       # 测试任务持久化（config/result/metrics）
│   └── static/
│       ├── index.html     # 单页布局（测试面板/弹窗骨架）
│       ├── app.js         # 全部前端逻辑（原生 JS）
│       ├── style.css      # 样式
│       ├── echarts.min.js # 图表库（本地引入）
│       └── marked.min.js  # Markdown 渲染（报告模式）
├── config.json            # 模型列表 + Prometheus 配置（运行时生成）
├── workspace/             # 历史测试任务目录（运行时生成）
│   └── 文本测试-YYYYMMDDHHMM[-seq]/
│       ├── config.json    # 启动时写入：参数 + 模型快照 + started_at
│       ├── result.json    # 结束时写入：完整结果 + 指标汇总
│       └── metrics.json   # Prometheus 快照（有配置且拉取成功时）
├── doc/
│   ├── metrics.md         # 指标体系深度分析（案例一~四）
│   ├── monitoring.md      # Prometheus 监控设计文档
│   └── comparation.md     # 测试对比分析
├── spec/                  # 本设计文档
├── requirements.txt
└── README.md
```

---

## 4. 后端模块设计

### 4.1 `main.py` — API 层

职责：参数校验（Pydantic + 手工范围检查）、路由分发、SSE 流生成。无业务状态。

参数校验规则：

| 参数 | 范围 | 默认 |
|---|---|---|
| `noun_count` 名词数量 | 1–100 | 5 |
| `article_length` 文章字数 | 50–10000 | 500 |
| `concurrency` 并发度 | 1–1000 | 2 |

**SSE 流设计**（`GET /api/tests/text/case/{case_id}/stream`）是前后端协议的核心：

| 事件 | 触发条件 | 载荷 |
|---|---|---|
| `snapshot` | `qa_version` 变化（新问答开始/结束）或 case 终态 | `{case: 完整详情(含 qa_history), test_status}` |
| `delta` | 正在生成的 qa 的 `partial` 增长（每 250ms 扫描一次） | `{i: qa下标, text: 增量文本, chars: 当前总字符数}` |
| `stats` | 每 5s | `{case: 详情(不含 qa), test_status}` |
| `end` | 测试结束或 case 终态，推送后关闭流 | `{}` |

实现细节：

- 服务端以 250ms 周期轮询内存中的 `CaseState`，对比 `last_version`（qa 结构版本号）与 `last_lens`（各 qa partial 长度）决定推送快照还是增量——**结构变化走快照，纯文本增长走增量**，兼顾正确性与流畅度。
- 客户端断开由 FastAPI 触发 `CancelledError`，直接结束。
- 响应头 `X-Accel-Buffering: no` 防反向代理缓冲。

**报告模式监控数据的三级回退**（`GET /api/tests/text/history/{task_name}/metrics`）：

1. **快照优先**：读 `workspace/<任务名>/metrics.json`（测试结束时存档，不受 TSDB 保留期限制）；
2. **实时查询**：无快照但有 Prometheus 配置时，按 `config.started_at + result.elapsed` 重算起止窗口调 `fetch_snapshot`（受 15 天保留期限制）；
3. **空数据**：返回 `{source: null, metrics: null}`，前端展示"无监控数据"。

**模型服务端参数探测**（`GET /api/models/{model_id}/probe`）：调用 `llm_client.probe_model_info` 探测 vLLM 版本 / 最大上下文 / KV cache 容量（原理见 §4.3），结果按配置指纹内存缓存——`_probe_cache[model_id] = {fingerprint: (url, model, api_key), data}`，指纹变化（编辑了服务地址/模型 ID/Key）自动失效重探，切换模型不重复探测。探测逻辑提取为 `_probe_model_cached()` 辅助函数，**测试启动接口复用同一缓存**：`POST /api/tests/text/start` 启动前快照一份探测结果随任务持久化（见 §4.4），前端选模型时已探测过故通常命中缓存零开销；探测失败不阻塞启动（快照为 null）。

### 4.2 `model_store.py` — 模型配置持久化

- 存储：项目根 `config.json`，结构 `{"models": [...], "prometheus": {url, grafana_url}}`，读写全程持线程锁。
- API Key 以 **base64 编码**存储（防肉眼泄露，非加密）；`encode_key`/`decode_key` 双向转换，解码失败返回空串。
- 模型条目：`{id: uuid4.hex[:8], name, model, url, api_key}`。
- **安全约定**：`list_models()` 返回的条目 `api_key` 恒为空串，仅带 `has_api_key` 布尔；明文 Key 只能通过 `GET /api/models/{id}/apikey` 单独获取（供前端编辑时回显）。
- `update_model` 的 api_key 三态语义：`None`=不变、空串=清除、非空=更新。

### 4.3 `llm_client.py` — LLM 客户端（工程细节最密集的模块）

#### 连接池复用

```python
_client_cache: dict  # key = f"{base_url}|{api_key}" -> (AsyncClient, 创建时的 event loop)
```

- 按 `(base_url, api_key)` 缓存 `httpx.AsyncClient`，避免每请求重建 TCP 连接。**实测依据**（doc/metrics.md 案例三）：内网 vLLM 每请求新建连接开销 p50≈10ms/均值≈20ms，100 并发冷启动放大到 p50 400ms+；复用后客户端 e2e TTFT 与服务端口径差距从 ~37ms 缩到 ~15ms。
- `limits = Limits(max_connections=256, max_keepalive_connections=256, keepalive_expiry=4.0)`：**keepalive_expiry 4s < uvicorn 服务端默认 5s**，让客户端先主动过期，规避撞上服务端已单方面关闭的连接。
- 缓存值记录创建时的 event loop，loop 更换或 client 已关闭则重建（旧 client 交给 GC）。
- **失效重试**：`RemoteProtocolError/ReadError/WriteError`（疑似失效 keep-alive 连接）触发 `_drop_client` 后台异步关闭 + 重建重试**一次**；`ConnectError`/超时不重试（新连接失败，重试无意义）。流式调用中**已收到部分数据则不重试**（重试会导致内容重复）。
- 默认 timeout 600s 仅兜底，各调用点按请求传入覆盖。

#### 请求构造

- 统一追加 `chat_template_kwargs: {"enable_thinking": False, "thinking": False}` **禁用思考过程**（所有问答建立在关闭 thinking 基础上）。
- URL 归一化：不以 `/chat/completions` 结尾则自动拼接。
- 非流式 `chat_completion`（用于验证连接）：timeout 30s（验证场景）/300s（默认）。
- 流式 `chat_completion_stream`：SSE 逐行解析 `data:` 前缀，`[DONE]` 终止，`choices[0].delta.content` 增量通过 `on_chunk(delta)` 回调实时上抛。**关键优势：read timeout 作用于相邻 chunk 之间而非整个请求**，长文章不会因总时长超时被误杀。
- 错误返回统一 `{"success": False, "error": "..."}`，超时带异常子类名（ConnectTimeout/ReadTimeout/...），注释明确指出"客户端超时放弃后服务端往往仍完成并记录 200，与 vLLM 日志全 200 不矛盾"。

#### vLLM 指标抓取与解析

- `_metrics_url(base_url)`：从 chat 地址推导 `/metrics` 端点（剥掉 `/chat/completions` 或 `/v1` 后缀）。
- `_parse_prometheus(text)`：正则解析 Prometheus 文本格式为 `{指标名: float}`，跳过注释行，带 label 的同名指标取最后一条。
- `extract_vllm_metrics(raw)`：`find(*names)` **两轮匹配**——第一轮精确匹配 `name` 与 `vllm:name`（避免 `external_prefix_cache_hits_total` 等同后缀指标误命中），第二轮后缀/包含匹配兜底兼容旧版命名变体。提取 15 个字段（详见 §6.3）。
- `extract_ttft_buckets(text)`：正则解析 TTFT 直方图桶累计计数 `time_to_first_token_seconds_bucket{le="..."}`，返回按 le 升序的 `[(le, count)]`（含 +Inf 桶）；同 le 多行取较大值（多实例场景取累计口径最大者）。
- `fetch_vllm_metrics()`：GET `/metrics`（timeout 10s），返回 `{success, metrics, ttft_buckets}`。

#### 服务端能力探测（probe_model_info）

选中模型后前端调 `GET /api/models/{id}/probe`（main.py 按指纹缓存，见 §4.1），后端独立探测三项服务端能力，单项失败仅该项为 `None`，互不阻塞：

| 探测项 | 方法 | 原理与兼容性 |
|---|---|---|
| vLLM 版本 | `GET /version` | vLLM v0.8+ 提供 JSON `{"version": "..."}`；非 vLLM 服务通常 404 → None |
| KV cache 容量 | `GET /metrics` → `cache_config_info` gauge 的 labels | 正则解析 label 键值对。**新版 vLLM 直接暴露 `kv_cache_size_tokens`（服务端自报口径，优先取）**；旧版无此 label 时回退 `num_gpu_blocks × block_size` 推算。混合架构（如 mamba+attention，block_size 为非常规值 784）下两者存在偏差，以自报值为准 |
| 最大上下文长度 | 试探请求 | 发送 `max_tokens=10000000` 的最小 chat 请求（`"hi"`），服务端在**参数校验阶段**直接返回 4xx 拒绝——不进调度器、不消耗 GPU，从错误信息中解析上限 |

**最大上下文的多格式解析**（`_MAX_LEN_PATTERNS`）：错误信息格式随服务端版本/实现演进，依次尝试三种正则，命中即止：

1. OpenAI / 旧版 vLLM：`This model's maximum context length is 8192 tokens. However, you requested ...`
2. 新版 vLLM（0.2x，实测 0.27.1）：`max_tokens=10000000 cannot be greater than max_model_len=max_total_tokens=262144. Please request fewer output tokens.`
3. 其他变体：`max_model_len=8192` / `max_model_len: 8192`

状态码同时接受 400/422（不同实现在参数校验失败时返回码不同）。

### 4.4 `test_engine.py` — 测试引擎（业务核心）

#### 状态机

```
引擎:  idle ──start()──▶ running ──全部case结束──▶ completed
                      │            ├──stop()──▶ stopped
                      └─(拒绝: 已running)        └─内部异常──▶ error
case:  pending/queued ──▶ running ──▶ completed | error | stopped
qa:    generating ──▶ done | error
```

#### 启动流程 `start()`

1. 校验：running 中拒绝；模型配置必须存在。
2. 构造 `concurrency` 个 `CaseState`（case_id 从 1 起），状态置 `queued`。
3. **全局名词池**：`pick_nouns_pool(noun_count × concurrency)`——总量 ≤ 2000（词库规模）时无放回抽样全局互不重复，各 case 取**不重叠分片**（case i 取 `[i*n, (i+1)*n)`）；超过时随机有放回，数量仍严格等于总量。
4. **错峰启动（ramp-up）**：`stagger = min(2.0, max(0.15, 10.0/(concurrency-1)))`，case i 延迟 `i × stagger`，总启动窗口控制在 ~10s，避免所有线程首请求同时打满服务器造成 prefill 风暴。
5. 启动 `_poll_vllm_metrics` 后台任务（每 5s）。
6. **启动即持久化** `workspace/<task_name>/config.json`（参数 + 模型快照 + `model_probe` 服务端参数快照 + started_at），结束后由 `_wait_all` 写 result——即使进程中途崩溃也能从 config 看到未完成任务。`model_probe` 为启动时刻探测的 vLLM 版本/最大上下文/KV 容量（由 main.py 启动接口探测后传入，见 §4.1），是报告模式 Profile 区域的数据源；与实时探测解耦，测试后服务端配置变化不影响历史报告。

#### `_wait_rampup` — 自适应顺延

错峰等待期间每 0.5s 检查 vLLM 排队：`waiting_requests > max(2, 并发数/2)`（服务器已过载排队）则顺延 0.5s，上限 30s；指标不可用时仅按固定错峰执行。

#### case 执行 `_run_case`

```
for i, noun in enumerate(nouns):
    检查 stop_event
    prompt = f'围绕"{noun}"写一篇{article_length}字的文章。直接输出文章正文。'
    qa = case.begin_qa(...)                      # 记录 req_t0 等计时锚点
    r = await chat_completion_stream(..., on_chunk=_on_chunk)
    成功 → end_qa(success=True) 累计 chars_generated
    失败 → end_qa(success=False) + add_error(明细记录)
```

- `max_tokens = max(2048, article_length × 2)`（中文约 1 字 ≈ 1 token，留一倍余量防截断）。
- `_on_chunk` 回调在事件循环内同步执行：首 chunk 记录 `first_chunk_at/first_chunk_chars`，每次更新 `last_chunk_at/chunk_count/partial`——**e2e 计时的全部原始数据在此采集**。
- case 内部异常（非 API 错误）记为"内部异常"错误记录，case 状态置 error；**有 API 错误仍标记 completed**（错误通过计数与明细传递，不中断整体）。

#### 错误明细 `error_records`

每次错误记录 `{ts, phase(生成文章/内部异常), loop, noun, duration, error}`，供前端错误明细弹窗展示，便于区分超时/连接失败/服务端 4xx5xx。

#### 收尾 `_wait_all`

所有 case 结束后：再抓一次 vLLM 指标（`_fetch_metrics_once`）→ `save_result` 落盘 → 触发 `_snapshot_metrics`（Prometheus 快照，异步不阻塞）→ 引擎状态迁移。

### 4.5 `noun_library.py` — 名词库

- 内置约 2000 个中文名词（含科技/自然/人文等类别），纯静态数据，无外部依赖。
- `pick_nouns_pool(total)`：`total ≤ 词库规模` 时 `random.sample` 无放回抽样（全局不重复）；否则循环随机有放回，保证返回数量恒等于 `total`。
- 设计意图：名词作为 prompt 主体，保证各请求内容不同（避免 prefix cache 命中干扰裸性能测试），且可复现地覆盖不同 token 组合。

### 4.6 `prom_snapshot.py` — Prometheus 快照

- **METRICS 常量**定义 7 条查询，每条含 `promql`、`title`、`unit`、`group`（concurrency/cache/latency/throughput/preemption 五组），PromQL 用 `or` 兼容新旧命名（如 `vllm:num_requests_running` or `vllm:num_requests_waiting`）。
- `_step_for(start, end)`：自适应采样步长，目标每序列约 240 个点，下限 5s——短测试用 5s 步长保细节，长测试自动放大步长防响应过大。
- `_query_range`：对每条 PromQL 调 `/api/v1/query_range`，**多序列（按 instance/job 分组）时取点数最多的序列**；单条失败不影响其他，返回 `{name, series: [{t, v}], error}`。
- `_compute_stats`：从时序计算统计卡片——
  - `gen_throughput`: avg + peak（token/s）
  - `ttft_p50_avg_ms` / `ttft_p95_peak_ms`：均值取 p50 序列平均、峰值取 p95 序列最大，单位换算 ×1000
  - `kv_cache_peak_perc`：`gpu_cache_usage_perc` 序列最大值 ×100
  - `preemptions_rate_peak`：抢占速率峰值
- `fetch_snapshot(base_url, start, end)`：并发拉取（asyncio.gather），返回带 `schema_version/source/range/fetched_at/series/stats` 的完整快照。
- `save_metrics/load_metrics`：读写 `workspace/<任务名>/metrics.json`。

### 4.7 `workspace.py` — 任务持久化

- 任务目录命名：`<测试类型>-<时间戳 YYYYMMDDHHMM>`，同分钟冲突追加 `-2/-3` 后缀。
- `valid_name` 校验任务名（防路径穿越），目录不存在返回 None。
- `save_config`（启动时）/`save_result`（结束时）分别写 `config.json`/`result.json`。
- `list_history()`：扫描 `workspace/` 下所有任务目录，读 config（含 started_at）**倒序**返回，供前端历史列表。
- `load_config/load_result`：报告模式回放数据源。

---

## 5. 前端设计

### 5.1 页面布局（index.html）

单页应用，自上而下分为：

1. **顶栏**：平台标题 + 副标题；右侧"历史报告"入口按钮。
2. **模型区**：模型下拉选择框（显示 name）+ "模型管理"按钮（打开管理弹窗）。
3. **参数区**（两行网格）：
   - 第一行：模型配置下拉框（占 1/4 宽）+ **服务端参数探测条**（占余下 3/4，见 5.5）；
   - 第二行：迭代次数（每 Thread）/ 输入长度（token）/ 输出长度（token）/ 并发度四个输入项 + "运行测试"/"停止"按钮。
4. **运行状态区**：
   - 汇总卡片行：总调用数、错误数、总字符数、已用时间等；
   - vLLM 实时指标卡：running/waiting、KV cache 使用率、生成吞吐、TTFT/TPOT 均值、prefix cache 命中率等（有数据才渲染）。
5. **case 网格**：每个 case 一张卡片（状态色标、进度、当前名词、字符数、耗时），点击打开详情弹窗。
6. **弹窗层**：
   - case 详情弹窗（SSE 流式，见 5.3）；
   - 模型管理弹窗（列表 + 新增/编辑表单，见 5.2）；
   - Prometheus 配置弹窗（url + grafana_url，"测试连接"按钮）；
   - 错误明细弹窗；
   - 历史报告列表弹窗。
7. **报告模式**：从历史列表打开后，主区域切换为报告视图（配置回显 + 汇总指标 + ECharts 监控图表组）。

技术选型：原生 JS（无框架）、ECharts（本地引入）、marked（报告模式渲染 Markdown 说明）。

### 5.2 模型管理弹窗 — 状态机交互

列表态 → 编辑态（新增或修改）→ 验证 → 保存：

```
[列表] ──新增/编辑──▶ [编辑表单]
                      │ 点击"验证连接" → POST /api/verify-model
                      │   成功：显示 ✓ 可用（提示可保存）
                      │   失败：显示 ✗ + 错误信息（仍可保存）
                      └ 点击"保存" → POST/PUT /api/models → 刷新列表
[列表] ──删除──▶ 确认 → DELETE /api/models/{id}
```

- 编辑已有模型时通过 `GET /api/models/{id}/apikey` 单独拉取明文 Key 回显输入框（列表接口不返回 Key）。
- 保存后刷新下拉选择框；若当前选中模型被删除则清空选择。

### 5.3 测试运行时交互

- **启动**：`POST /api/tests/text/start` 成功后开启 2s 间隔轮询 `GET /api/tests/text/status`，刷新汇总卡片、vLLM 指标卡、case 网格。
- **case 详情**：点击卡片建立 `EventSource` 连接 `/api/tests/text/case/{id}/stream`：
  - `snapshot` → 全量重渲染（含历史问答列表）；
  - `delta` → 对第 i 个问答追加文本（打字机效果）；
  - `stats` → 更新统计行；
  - `end` → 关闭连接。
  - 弹窗关闭即 `es.close()`；case 终态后服务端主动发 `end` 关流。
- **停止**：`POST /api/tests/text/stop`，状态轮询直至引擎离开 running。

### 5.4 报告模式

1. 历史列表（`GET /api/tests/text/history`）选择任务 → `GET /api/tests/text/history/{name}` 取 config+result。
2. 渲染：测试参数回显、e2e 汇总（总调用/错误/字符/时长/各分位）、vLLM 指标汇总卡（终值差分口径）。
3. **Profile 区域**（`#profileBar`，位于汇总行与 vLLM 指标条之间，仅报告模式显示）：展示**启动时刻**的快照记录——模型名（跨全列）+ 当时探测的 vLLM 版本 / 最大上下文 / KV cache 容量（`config.model_probe`，`fmtTokens` 缩写格式与探测条一致）+ 迭代次数 / 输入长度（中文档位标签）/ 输出长度 / 并发度（`config.params`）。数据全部来自 config 持久化，不随实时探测变化；旧任务无 `model_probe` 字段时对应项显示 "—"。运行模式各渲染路径（`renderStatus`、新测试、启动测试、轮询空态）统一隐藏该区域。
4. 监控图表：`GET .../history/{name}/metrics`（三级回退，见 §4.1）→ 按 group 渲染 5 组 ECharts 时序图（并发/缓存/延迟/吞吐/抢占），x 轴为时间，支持 dataZoom。
5. Grafana 链接：配置了 grafana_url 时提供跳转链接（带时间范围参数）。

### 5.5 模型服务端参数探测条

选中模型后自动探测服务端关键配置（调 `GET /api/models/{id}/probe`），展示在参数区第一行模型下拉框右侧（`#modelInfo`，grid 占 `2 / -1` 列，与下拉框底部对齐，虚线边框弱化视觉层级）：

```
vLLM 版本: 0.27.1 │ 最大上下文: 256K token │ KV cache 容量: 385.5K token
```

- **触发时机**：模型下拉框 `change`、页面初始化时已有选中模型、报告模式加载历史模型后（探测条反映该模型**当前**的服务端状态，与 Profile 区域的启动时刻快照互补）；「新测试」清空模型时隐藏探测条并复位并发度 label。
- **过期响应防护**：`probeSeq` 自增序号，异步响应返回时与当前序号不符则丢弃——快速切换模型时防止旧模型的响应覆盖新状态。
- **token 数缩写**（`fmtTokens`）：≥ 1M（1024²）显示 `x百万`、≥ 1K（1024）显示 `xK`；恰为整数不带小数位，否则保留一位（8K / 256K / 3.3百万）。采用 **1024 进制**（LLM 行业惯例：262144 → 256K 而非 262.1K）。
- **视觉格式**：参数名与值之间加冒号，值加粗（`<b>`）；参数间竖线 `│`（`.info-sep`，取浅色 `--border` 弱化，间距 10px）。
- **并发度预估 hint**：有 KV 容量数据时，并发度 label 变为 `并发度（预估最大 ~N）`，`N = KV 容量 ÷ (输入长度档位 token 数 + 输出长度)`，随输入/输出长度联动刷新——帮助用户启动前判断并发是否超出 KV 容量（输入档位 → token 数映射：tiny 10 / short 100 / medium 1000 / long 8000 / xlong 16000）。
- 探测失败（非 vLLM 服务或网络错误）显示"服务端参数不可用"，不阻塞测试流程。

---

## 6. 指标体系详解（核心）

### 6.1 三套指标体系总览

| 体系 | 采集点 | 频率 | 用途 | 局限 |
|---|---|---|---|---|
| **客户端 e2e** | `_on_chunk` 回调（浏览器↔后端链路） | 每 chunk | 用户真实体感：TTFT/TPOT/吞吐 | 含网络+客户端开销；不含排队细节 |
| **vLLM 服务端** | 轮询 vLLM `/metrics` | 每 5s | 服务器内部视角：排队/KV/抢占/服务端 TTFT | 采样粒度粗；counter 需差分 |
| **Prometheus 快照** | 测试结束 query_range | 一次性 | 历史回放、跨任务对比、报告图表 | 依赖外部 Prometheus；15 天保留期 |

三套体系**互相印证**而非互相替代：e2e 与服务端 TTFT 的差值可定位网络/客户端开销；vLLM 轮询与 Prometheus 时序的差值可发现采样盲区。

### 6.2 客户端 e2e 指标（`CaseState`）

**原始计时锚点**（`begin_qa`/`_on_chunk`/`end_qa` 采集）：

| 字段 | 含义 |
|---|---|
| `req_t0` | 请求发出时刻 |
| `first_chunk_at` / `first_chunk_chars` | 首个内容 chunk 的时刻与其累计字符数 |
| `last_chunk_at` | 最后一个 chunk 时刻 |
| `chars` | 该 qa 成功生成的总字符数 |

**单问答（qa）公式**：

```
TTFT   = first_chunk_at - req_t0                 # 首字延迟（含排队+prefill+网络）
gen_span = last_chunk_at - first_chunk_at        # 纯生成阶段时长
TPOT   = gen_span / (chars - first_chunk_chars)  # 秒/字符（首 chunk 后平均每字符间隔）
吞吐   = chars / (last_chunk_at - req_t0)        # 字符/秒（含 TTFT 的整体速率）
```

**case 级聚合**（`end_qa` 累计，`case_summary` 输出）：

```
e2e_chars    = Σ qa.chars                        # case 总生成字符
e2e_gen_time = Σ qa.gen_span                     # 纯生成时长合计
case 吞吐     = e2e_chars / e2e_gen_time         # 字符/秒（不含 TTFT，衡量稳态生成速率）
```

注意：case 吞吐**剔除 TTFT 段**，与单 qa 吞吐（含 TTFT）口径不同——前者衡量生成器稳态能力，后者衡量单请求整体速率。

### 6.3 vLLM 服务端指标（轮询 + 差分）

**`extract_vllm_metrics` 提取的 15 个字段**（两轮名称匹配兼容新旧版本）：

| 字段 | vLLM 指标 | 类型 |
|---|---|---|
| `running_requests` | num_requests_running | gauge |
| `waiting_requests` | num_requests_waiting | gauge |
| `gpu_cache_usage` | gpu_cache_usage_perc / kv_cache_usage_perc | gauge |
| `gen_throughput_toks` | generation_tokens_seconds（旧版 gauge） | gauge |
| `prompt_tokens_total` | prompt_tokens_total | counter |
| `generation_tokens_total` | generation_tokens_total | counter |
| `ttft_sum` / `ttft_count` | time_to_first_token_seconds_sum/_count | counter |
| `tpot_sum` / `tpot_count` | time_per_output_token_seconds_sum/_count | counter |
| `prefix_hits` / `prefix_queries` | prefix_cache_hits/queries_total | counter |
| `preemptions_total` | preemptions_total | counter |
| `requeue_total` | requeue_requests_total | counter |

**`_poll_vllm_metrics`（每 5s）→ `_apply_metrics_sample` 差分逻辑**：

1. **TTFT 桶基线差分**：`extract_ttft_buckets` 得到的是 histogram **累计计数**，直接用会把 vLLM 启动以来的历史都算进来。引擎记录首轮桶为基线 `ttft_bucket_base`，每轮用 `cur - base` 得到**本轮测试新增分布**。
2. **vLLM 重启检测**：若 `cur < base`（counter 回绕=服务重启），重新校准基线为当前值。
3. **gen_throughput_toks 差分**：新版 vLLM 移除了 gauge 型吞吐指标，改为对 `generation_tokens_total` 做 `(cur - last) / dt` 差分求瞬时吞吐。
4. **9 个 counter 基线差分**：`prompt_tokens_total`、`generation_tokens_total`、`ttft_sum/count`、`tpot_sum/count`、`prefix_hits/queries`、`preemptions_total`、`requeue_total` 同样记录基线，每轮差分。
5. **重算本轮均值**：`ttft_avg_s = Δttft_sum / Δttft_count`（差分后的均值才是**本轮**请求的均值，而非 vLLM 启动以来的累计均值）；`prefix_cache_hit_rate = Δhits / Δqueries`。

**`_accumulate_metrics_stats`（时间平均与峰值）**：

- 峰值类：`running_max`、`waiting_max`、`gpu_cache_peak`（gauge 直接取 max）；
- 时间平均类：`gen_throughput`、`gpu_cache_usage`、`prefix_cache_hit_rate`、`ttft_avg_s`、`tpot_avg_s` 按**采样点等权平均**（每 5s 一个点的算术平均，非请求加权）。

**`_vllm_metrics_summary`（测试结束的最终汇总）— 两种口径的取舍**：

```
优先：final_ratio = (终值 - 基线) / Δcount      # 终值差分（请求等权）
回退：avg of 采样点                              # 时间平均（时间等权）
```

- TTFT/TPOT 均值、prefix 命中率等 **ratio 型指标优先用终值差分**：`Δsum/Δcount` 恰好是**本轮所有请求的等权平均**。
- **为什么不用时间平均**（doc/metrics.md 案例二）：排队积压期 TTFT 上涨，F(t)=sum(t)/count(t) 是累计均值，采样点时间平均会被"早期低值稀释 + 后期高值截断"双重失真；终值差分天然对请求等权，语义正确。
- tokens 总量、preemptions 等绝对量直接取**最后快照的差分值**（累计语义）。

### 6.4 TTFT 分位数拟合（`_fit_ttft_quantiles`）

**问题**：vLLM 只暴露 TTFT histogram 桶（如 le=0.001/0.005/0.01/0.05/0.1/...），`histogram_quantile` 的线性插值在**宽桶**（如 0.1s~0.5s 之间无细分）且真实分布右偏时会显著失真——doc/metrics.md 案例四实测插值 p95 与真实分位偏差可达 30%+。

**方案**：对数正态区间删失（interval-censored）最大似然拟合：

1. 桶计数差分后得到区间样本数：`(a, b]` 区间内 `n_k` 个样本（a/b 为相邻桶 le 值）。
2. 似然函数：`L(μ,σ) = Π_k [Φ((ln b_k - μ)/σ) - Φ((ln a_k - μ)/σ)]^n_k`。
3. **锚定 μ**：用桶计数算出样本均值 `m` 与方差 `v`，取 `μ = ln(m) - σ²/2`（对数正态均值公式反解），将二维优化降为**一维**。
4. **黄金分割搜索 σ ∈ [1e-4, 5]**（对数似然单峰，收敛稳定）。
5. 输出：`p50 = exp(μ)`，`p95 = exp(μ + 1.6449σ)`（1.6449 为标准正态 95% 分位 z 值）。

**适用前提**：TTFT 分布近似对数正态（右偏、非负），这在排队+prefill 场景下通常成立；拟合结果与直方图总量校验（Σ桶计数一致）。

### 6.5 Prometheus 快照指标

7 条时序（5 组）与统计卡片见 §4.6。口径说明：

- 时序图反映**测试窗口内**服务器状态演变（起止 = started_at ~ started_at+elapsed）；
- `ttft_p50_avg_ms` 是 **p50 序列的时间平均**（每个采样点都是"截至该时刻的累计 p50"，时间平均近似窗口内典型水平），与 §6.3 的请求等权口径不同，对比时需注意；
- 快照存档后**永久可回放**，不受 Prometheus 15 天保留期限制——这是"快照优先"三级回退的设计动机。

### 6.6 口径对比与常见陷阱（来自 doc/ 实测结论）

| 陷阱 | 说明 | 本项目的对策 |
|---|---|---|
| e2e vs 服务端 TTFT 差距大 | 连接建立开销（案例三：冷启动 p50 400ms+） | 连接池复用 + keepalive_expiry 4s |
| 累计均值 vs 本轮均值 | vLLM counter 含启动以来历史 | 全量 counter 基线差分 + 重启检测 |
| 时间平均 vs 请求平均 | 排队期 F(t) 失真（案例二） | ratio 指标优先终值差分（请求等权） |
| histogram 宽桶插值失真 | 线性插值假设桶内均匀（案例四） | 对数正态区间删失 MLE 拟合 |
| 客户端超时 vs 服务端 200 | 客户端放弃后服务端仍完成 | 错误明细区分超时子类；注释说明口径 |
| prefix cache 干扰 | 相同前缀命中缓存导致 TTFT 虚低 | 名词池保证 prompt 主体互不相同 |
| prefill 风暴 | 全并发同时首发请求 | 错峰启动 + 排队自适应顺延 |

---

## 7. 数据持久化设计

### 7.1 `config.json`（项目根）

```json
{
  "models": [
    {"id": "a1b2c3d4", "name": "本地vLLM", "model": "Qwen2.5-7B",
     "url": "http://127.0.0.1:8000/v1/chat/completions", "api_key": "<base64>"}
  ],
  "prometheus": {"url": "http://127.0.0.1:9090", "grafana_url": "http://127.0.0.1:3000"}
}
```

### 7.2 `workspace/<任务名>/`

| 文件 | 写入时机 | 内容 |
|---|---|---|
| `config.json` | 测试启动时 | 参数（noun_count/article_length/concurrency）+ 模型快照 + `model_probe`（启动时刻探测的 vLLM 版本/最大上下文/KV 容量）+ started_at |
| `result.json` | 测试结束时 | 引擎状态、各 case 详情（含 qa_history、e2e 计时）、错误明细、vLLM 指标汇总（含 TTFT 拟合分位） |
| `metrics.json` | 测试结束后异步 | Prometheus 快照（schema_version/source/range/series/stats） |

**崩溃一致性**：config 先写、result 后写——进程崩溃时可通过"有 config 无 result"识别未完成任务。

---

## 8. API 接口清单

### 模型管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/models` | 列表（不含明文 Key，带 has_api_key） |
| POST | `/api/models` | 新增 |
| PUT | `/api/models/{id}` | 更新（api_key 三态：None 不变/空串清除/非空更新） |
| DELETE | `/api/models/{id}` | 删除 |
| GET | `/api/models/{id}/apikey` | 单独获取明文 Key（编辑回显用） |
| POST | `/api/verify-model` | 验证连接（非流式 chat，timeout 30s） |
| GET | `/api/models/{id}/probe` | 探测服务端配置（vLLM 版本/最大上下文/KV 容量，指纹缓存，见 §4.3） |

### 文本测试

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/tests/text/start` | 启动（running 中返回 409）；启动前快照模型探测结果随任务持久化 |
| GET | `/api/tests/text/status` | 引擎状态 + 汇总 + vLLM 指标 + case 列表（轮询 2s） |
| POST | `/api/tests/text/stop` | 停止（asyncio.Event 广播） |
| GET | `/api/tests/text/case/{id}` | case 详情（含 qa_history） |
| GET | `/api/tests/text/case/{id}/stream` | SSE 流（snapshot/delta/stats/end，见 §4.1） |

### 历史与报告

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tests/text/history` | 任务列表（按 started_at 倒序） |
| GET | `/api/tests/text/history/{task_name}` | config + result 回放 |
| GET | `/api/tests/text/history/{task_name}/metrics` | 监控数据（快照→实时→空 三级回退） |

### Prometheus 配置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/api/prometheus/config` | 读/写 url + grafana_url |
| POST | `/api/prometheus/test` | 连接测试（瞬时查询） |

静态资源挂载在 `/`（`app/static`）。

---

## 9. 关键设计决策与权衡

1. **无数据库、纯文件持久化**：单机工具定位，JSON 文件即可满足；代价是并发写需加锁、无跨机共享。
2. **单例引擎、单轮测试**：简化状态管理，vLLM 指标基线差分也依赖"一轮测试"的明确边界；代价是无法并行跑多轮。
3. **SSE 而非 WebSocket**：单向推送场景 SSE 足够，且 EventSource 自带断线语义；delta/snapshot 双事件设计平衡了流畅度与一致性。
4. **连接池 + keepalive_expiry=4s**：以"客户端先过期"换取不撞服务端 5s 关闭，是实测调优结论（案例三）而非理论推导。
5. **counter 全量基线差分 + 重启检测**：保证指标只反映本轮测试；重启回绕用 `cur < base` 检测并重校准。
6. **ratio 指标终值差分优先**：请求等权语义正确，规避 F(t) 累计均值的时间平均失真（案例二）。
7. **对数正态 MLE 拟合 TTFT 分位**：修复 histogram_quantile 宽桶插值失真（案例四）；一维黄金分割搜索保证数值稳定。
8. **监控三级回退（快照→实时→空）**：快照永久可回放但依赖测试时已配置；实时查询覆盖"补配置"场景；空数据优雅降级。
9. **名词池防 prefix cache 干扰**：prompt 主体互不相同，测的是裸性能而非缓存命中性能。
10. **错峰启动 + 排队自适应顺延**：避免人为 prefill 风暴扭曲首轮 TTFT，同时防止服务器过载时雪崩。
11. **试探请求探测 max_model_len**：发送 max_tokens 超大的最小请求，被服务端在参数校验阶段直接拒绝（不进调度、不消耗 GPU），从 4xx 错误信息多格式解析上限——OpenAI 兼容服务通用，不依赖 vLLM 专属 API；代价是错误信息格式随版本演进需持续兼容（`_MAX_LEN_PATTERNS` 三模式，实测 0.27.1 已换用 `max_total_tokens=` 格式）。
12. **探测结果指纹缓存**：按 (url, model, api_key) 缓存，配置变更自动失效——避免每次切换模型都发 3 个探测请求（其中试探请求虽不耗 GPU 但有网络往返）。
13. **启动快照与实时探测分离**：测试场景区的探测条始终反映模型**当前**服务端状态（辅助配置下一轮测试），而报告模式 Profile 区域展示**启动时刻**的探测快照（随 config.json 持久化）——测试后服务端改配置（如重启换 `--max-model-len`）不会篡改历史报告的记录口径；代价是旧任务无 `model_probe` 字段需显示 "—" 兜底。

---

*文档生成于 2026-08-28；2026-08-31 增补：模型服务端能力探测（§4.1/§4.3/§5.5/§8/§9）、报告模式 Profile 快照区（§4.1/§4.4/§5.4/§8/§9）。对应代码版本：main 分支。*
