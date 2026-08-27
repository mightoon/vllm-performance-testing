# 监控指标可视化（Prometheus 快照 + 报告模式图表）设计文档

> 版本：v1.0
> 日期：2026-08-26
> 状态：方案已确认，待实施

---

## 1. 背景与目标

vLLM 压力测试过程中的服务端指标已由 Prometheus 采集，并在 Grafana 中配置了
Dashboard 完成可视化。本功能的目标：**测试平台在"展示报告模式"下，能够根据
测试的起始/结束时间，将该时间段内的 vLLM 服务端指标以图表形式展示**（位于
测试运行状态 panel 下方），且不受 Prometheus TSDB 数据保留期（默认 15 天）
的限制。

### 1.1 需求确认结论

| # | 需求点 | 结论 |
|---|--------|------|
| 1 | 指标清单 | 首批按下文清单实现（不含 DCGM），**后续必须可扩展** |
| 2 | Prometheus 地址配置 | 放主页右上角"设置"弹窗，弹窗改造为两个 tab：「大模型配置」（现有内容不变）+「Prometheus」 |
| 3 | 实时模式 | **不显示图表**，保持现有 vllm-bar 轻量指标条；图表只在报告模式出现 |

---

## 2. 方案选型

### 2.1 候选方案对比

| 维度 | 方案 1：Prometheus 取数 + 自渲染 | 方案 2：iframe 嵌入 Grafana panel |
|------|------|------|
| 原理 | 按任务起止时间调 Prometheus `query_range` API，前端 ECharts 渲染 | `http://grafana:3000/d/<uid>?viewPanel=<id>&from=<ms>&to=<ms>&kiosk` |
| 开发量 | 图表库引入 + 后端代理端点（约半天） | 低（拼 URL） |
| 认证/嵌入限制 | 无（后端代理转发，前端不直连） | 需开启 `allow_embedding`、匿名访问或反代注入认证 |
| 视觉一致性 | 与平台 UI 统一，可自由排版、加标注 | Grafana 风格，多 panel 排版僵硬、高度自适应困难 |
| 上下文叠加 | 可叠加测试起止线、爬坡阶段标注 | 不可 |
| 配置负担 | 平台设置中一个 Prometheus URL | 每个 panel 手工配 dashboard uid + panel id |

### 2.2 选定方案

**方案 1（Prometheus 取数 + 自渲染）为主体**，辅以：

- **测试结束快照存档**：测试结束时立即把关键指标时序数据拉取并存入任务目录，
  彻底消除 15 天保留期问题，报告永久可看；
- **Grafana 跳转链接**：配置了 Grafana 地址时，图表区右上角提供
  「在 Grafana 中查看」链接（带 `from/to` 时间参数），保留深入分析能力，
  但不承担嵌入。

### 2.3 数据流架构

```
测试结束（completed / stopped / error）
    │
    ▼
后端按起止时间调 Prometheus query_range
    │
    ▼
快照存入 workspace/<task>/metrics.json
    │
    ▼
报告模式加载 → 前端请求 → 后端（快照优先，实时查询兜底）→ ECharts 渲染
    │
    └── panel 下方附「在 Grafana 中查看」跳转链接（可选）
```

---

## 3. 关键设计决策

### 3.1 快照时机：测试结束立即拉取

- 挂钩点：`test_engine.py` 的 `_wait_all()`，在写完 `result.json` 之后
- 方式：`asyncio.create_task` 后台执行，**不阻塞测试结束流程**
- 容错：全程 try/except 静默容错——快照失败不影响测试结果落盘

### 3.2 存储形式：JSON 文件，不部署额外 TSDB

- Prometheus `query_range` 返回的 matrix 本身就是 JSON（每序列为
  `[timestamp, value]` 点数组），**零转换**即可存储与喂给图表库
- 数据量小：约 10 个指标 × 每序列 200~240 点 ≈ **100~300 KB / 次测试**
- 数据是**只读存档**，查询模式为"按任务整块加载"，不需要任意范围查询/聚合
  （TSDB 的能力用不上），独立文件即可满足
- 存储位置：任务目录下独立文件 `metrics.json`，**不嵌入 `result.json`**
  （职责分离，快照失败互不污染；报告接口由后端合并返回）

### 3.3 渲染形式：折线图 + 统计卡片，不用仪表盘（gauge）

gauge 是"当前瞬时值"的隐喻，而报告回看的是已结束的历史区间，没有"现在"；
强行使用只能显示均值，信息密度过低。选定组合：

| 形式 | 适用 | 说明 |
|------|------|------|
| 时序折线图 | 过程指标：并发/排队、KV cache、延迟分位数、吞吐 | 主体。同 group 多序列同图（如 running + waiting 双线），可叠加测试起止标注 |
| 统计卡片 | 汇总指标：平均/峰值吞吐、平均 TTFT、KV cache 峰值 | 图表区顶部一排大数字，风格对齐现有 vllm-bar |

图表库：**ECharts**（UMD 单文件本地引入，同 `marked.min.js` 方式，内网可用，
中文文档完善）。

### 3.4 指标清单：代码内常量，数据驱动

清单放在 `prom_snapshot.py` 的 `METRICS` 常量（Python 列表），每条含
PromQL、分组、单位、图例名。**加指标 = 向列表追加条目**（后续 DCGM、
新版本 vLLM 指标名均如此扩展），不做用户可编辑配置——加指标是开发行为
（需写 PromQL、定分组），代码列表最直接。

拉取时**容忍缺失**：单条查询失败/无数据则跳过该条，不整体失败。

---

## 4. 指标清单（首批）

> 注：PromQL 兼容新旧 vLLM 命名（旧版无前缀，新版 `vllm:` 前缀；
> kv cache 指标新版由 `gpu_cache_usage_perc` 改名 `kv_cache_usage_perc`），
> 使用 PromQL `or` 回退：前者无数据时自动使用后者。

| 组 (group) | key | 图例 | PromQL（简写，实际含 or 回退） | 单位 | 图表 |
|------------|-----|------|--------|------|------|
| concurrency | `num_requests_running` | 运行中请求 | `num_requests_running or vllm:num_requests_running` | req | 折线（同图双线） |
| concurrency | `num_requests_waiting` | 排队请求 | `num_requests_waiting or vllm:num_requests_waiting` | req | ↑ |
| cache | `kv_cache_usage` | KV cache 使用率 | `gpu_cache_usage_perc or vllm:kv_cache_usage_perc`（0-1 → %） | % | 折线（0-100） |
| latency | `ttft_p50` | TTFT p50 | `histogram_quantile(0.5, sum by (le) (rate(...time_to_first_token_seconds_bucket[30s])))` | s→ms | 折线（同图双线） |
| latency | `ttft_p95` | TTFT p95 | `histogram_quantile(0.95, ...)` | s→ms | ↑ |
| throughput | `gen_throughput` | 生成吞吐 | `rate(generation_tokens_total[1m]) or rate(vllm:generation_tokens_total[1m])` | tok/s | 折线 + 卡片 |

实现备注（实测发现）：
- Prometheus 返回的 value 为**字符串**，需转 float
- 直方图在无数据窗口返回 **NaN**，转为 null 存储（ECharts 断线渲染），
  否则 FastAPI JSONResponse 会因 "Out of range float values" 报 500

统计卡片（后端预计算入 `stats`）：

| 卡片 | 取值 |
|------|------|
| 平均生成吞吐 | `gen_throughput` 序列均值 |
| 峰值生成吞吐 | `gen_throughput` 序列最大值 |
| 平均 TTFT p50 | `ttft_p50` 序列均值（ms） |
| 峰值 TTFT p95 | `ttft_p95` 序列最大值（ms） |
| KV cache 峰值 | `gpu_cache_usage_perc` 序列最大值 |

### 后续扩展预留

- DCGM（GPU 利用率/显存）：追加 `gpu` 组条目
- 请求成功/失败增量：`increase(request_success_total[1m])` 等
- 新版 vLLM 指标名前缀（`vllm:*`）：修改 PromQL

---

## 5. 数据结构

### 5.1 快照文件 `workspace/<task>/metrics.json`

```json
{
  "schema_version": 1,
  "task_name": "文本测试-202608261400",
  "source": "http://192.168.1.100:9090",
  "range": { "start": 1693000000, "end": 1693000900, "step": 5 },
  "fetched_at": 1693000910,
  "series": [
    {
      "key": "num_requests_running",
      "group": "concurrency",
      "legend": "运行中请求",
      "unit": "req",
      "promql": "num_requests_running",
      "data": [[1693000000, 0], [1693000005, 6]]
    },
    {
      "key": "gen_throughput",
      "group": "throughput",
      "legend": "生成吞吐",
      "unit": "tok/s",
      "promql": "rate(generation_tokens_total[1m])",
      "data": [[1693000000, 0], [1693000005, 842]]
    }
  ],
  "stats": {
    "gen_throughput_avg": 1240,
    "gen_throughput_peak": 1802,
    "ttft_p50_avg_ms": 245.3,
    "ttft_p95_peak_ms": 890.1,
    "kv_cache_peak_perc": 87.2
  }
}
```

设计要点：

- `data` 用 `[t, v]` 二元组数组而非对象，体积省约一半
- `group` 控制前端分组渲染（同 group 画同一张图）
- `stats` 由后端预计算，前端免算、免处理 NaN
- `promql` 存档便于将来在 Grafana 复现同一查询
- `schema_version` 为结构演进留余地
- **step 自适应**：`max(5, elapsed / 240)` 秒，保证每序列约 240 点以内
  （短测试高分辨率，长测试不超量）

### 5.2 平台配置 `config.json`（根目录，model_store.py 管理）

```json
{
  "models": [ ... ],
  "prometheus": {
    "url": "http://192.168.1.100:9090",
    "grafana_url": "http://192.168.1.100:3000/d/vllm-dcgm-v1/vllm-dcgm-gpu-monitoring"
  }
}
```

- `url`：Prometheus HTTP API 地址（必填，默认端口 9090；内网通常无认证，
  若有 basic auth/token 再扩展凭据字段）
- `grafana_url`：可选，**dashboard 完整地址**（`http://<host>:3000/d/<uid>/<slug>`），
  用于「在 Grafana 中查看」跳转链接，取数不依赖它
- 与 `models` 键并存，复用 model_store 现有锁与读写（现有代码读写整个 dict，
  `prometheus` 键自动随模型增删改保留）

---

## 6. 实施方案

### 6.1 后端

#### 6.1.1 `model_store.py` — 配置存储扩展

新增两个函数（复用现有 `_load_all/_save_all` 与锁）：

```python
def get_prometheus_config() -> dict      # 无配置时返回 {}
def save_prometheus_config(url: str, grafana_url: str) -> dict
```

#### 6.1.2 新文件 `prom_snapshot.py` — 快照核心

- `METRICS`：指标清单常量（见第 4 节）
- `fetch_snapshot(start: float, end: float) -> dict`：
  - 逐条调 Prometheus `/api/v1/query_range?query=<PromQL>&start&end&step`
  - `step = max(5, elapsed / 240)`
  - 单条失败/无数据跳过该条（不整体失败）
  - 同步预计算 `stats`（均值/峰值）
- `save_metrics(task_name: str, snap: dict) -> None`
- `load_metrics(task_name: str) -> Optional[dict]`

#### 6.1.3 `test_engine.py` — 测试结束挂钩

`_wait_all()` 写完 `result.json` 之后：

```python
# 后台拉取监控快照（不阻塞结束流程；失败静默，不影响测试结果）
asyncio.create_task(self._snapshot_metrics())
```

`_snapshot_metrics()` 内部：读 Prometheus 配置 → 无配置则跳过 →
`fetch_snapshot(started_at, finished_at)` → `save_metrics()`，全程容错。

#### 6.1.4 `main.py` — 3 个 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/prometheus/config` | 读配置 |
| PUT | `/api/prometheus/config` | 存配置（url 必填校验） |
| POST | `/api/prometheus/test` | 连通性验证（查 `up`，3s 超时） |
| GET | `/api/tests/text/history/{name}/metrics` | 报告模式取监控数据 |

报告取数 API 的**三级回退**：

```
1. 任务目录有 metrics.json → 直接返回（source: "snapshot"）
2. 无快照但有 Prometheus 配置 → 按该任务 config.json 的起止时间实时查询
   （15 天内有效，source: "live"）
3. 都没有 → 返回空（source: null），前端显示"无监控数据"占位
```

### 6.2 前端

#### 6.2.1 设置弹窗改造（index.html + style.css + app.js）

- 弹窗标题改为「设置」，顶部加 tab 栏：「大模型配置」+「Prometheus」
- 现有模型配置内容（列表 + 表单）**整体移入 tab 1，逻辑不动**
- tab 2 表单：
  - Prometheus URL（必填，placeholder：`http://192.168.1.100:9090`）
  - Grafana URL（可选，placeholder：`http://192.168.1.100:3000`）
  - 「测试连接」按钮（调 `/api/prometheus/test`，显示结果）
  - 「保存」按钮
- tab 样式复用主页 `.tabs` 风格

#### 6.2.2 报告模式监控图表（index.html + app.js + echarts.min.js）

- 位置：**运行状态 panel 下方**，新增「监控指标」区块
- **仅报告模式渲染**（`enterReportMode` 时加载；实时模式/新测试草稿不出现）
- 结构：
  1. 顶部一排统计卡片（风格对齐现有 vllm-bar）
  2. 按 `group` 分组的折线图卡片（concurrency 双线、cache 单线、latency 双线、
     throughput 单线）
- ECharts 本地文件引入（`static/echarts.min.js`，与 `marked.min.js` 同方式）
- 配置了 Grafana Dashboard URL 时，区块右上角「在 Grafana 中查看」链接：
  `{grafana_url}?from=<start_ms>&to=<end_ms>`（打开该 dashboard 并定位到测试时间段）
- 无数据时占位提示：「无监控数据」（本功能上线前的历史任务、未配置
  Prometheus、且超过 15 天的情况）

#### 6.2.3 图表细节

- x 轴：时间（HH:mm:ss），起止时间即测试区间
- tooltip：十字准线 + 各序列值
- 多序列同图使用区分色（复用平台配色变量）
- 空序列（该指标拉取失败/无数据）不渲染对应图，不报错

---

## 7. 容错策略汇总

| 场景 | 行为 |
|------|------|
| 未配置 Prometheus | 测试正常结束，不拉快照；报告显示"无监控数据" |
| 快照拉取失败（网络/超时） | 静默跳过，不影响 result.json；报告走实时兜底 |
| 单条指标查询失败/无数据 | 跳过该条，其余正常 |
| Prometheus 中途不可达 | 前端"测试连接"明确报错；报告三级回退 |
| 历史任务（功能上线前） | 无快照 → 实时查询兜底（15 天内）→ 空占位 |
| vLLM 重启导致 counter 归零 | 快照区间内数据仍正确（rate/increase 处理） |

---

## 8. 验证方案

1. **配置**：设置弹窗 → Prometheus tab → 填地址 → 测试连接（成功/失败两种）
2. **快照落盘**：跑一轮真实测试 → 结束后检查 `workspace/<task>/metrics.json`
   存在、series 非空、stats 合理
3. **报告渲染**：点击该历史任务 → 监控区块出现 → 卡片数值与图表曲线正确、
   时间轴与测试时长吻合
4. **实时兜底**：删除 `metrics.json` → 重新打开报告 → 仍能出图（live 来源）
5. **容错**：临时停掉 Prometheus → 重开报告 → 显示"无监控数据"，其余功能不受影响
6. **回归**：实时模式 vllm-bar 正常；设置弹窗 tab 1 模型配置功能不变

---

## 9. 文件改动清单

| 文件 | 改动 |
|------|------|
| `app/prom_snapshot.py` | **新增**：METRICS 清单、fetch/save/load |
| `app/model_store.py` | 新增 prometheus 配置读写 |
| `app/test_engine.py` | `_wait_all` 挂快照后台任务 |
| `app/main.py` | 新增 4 个 API 端点 |
| `app/static/index.html` | 设置弹窗 tab 化；报告模式监控区块 |
| `app/static/app.js` | 设置 tab 切换、Prometheus 表单；报告模式图表加载渲染 |
| `app/static/style.css` | tab 样式、监控区块样式 |
| `app/static/echarts.min.js` | **新增**：本地 ECharts 库 |
