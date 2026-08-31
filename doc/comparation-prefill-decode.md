# Prefill / Decode 阶段负载对比分析（2026-08-31）

> 本文围绕测试 `文本测试-202608311446`（长输入 8k / 短输出 200 / 并发 50）展开：该轮 TTFT 均值 28.3s、TPOT 均值 282ms、生成吞吐仅 124 tok/s，性能表现"异常差"。文中完整记录现象、原理、逐问分析与结论，并回答"输入 8k/输出 200 与输入 200/输出 8k 是否等价"这一对称性问题。

## 1. 环境与背景

- 模型：Qwen3.8（实例 c018133f），vLLM 0.27.1
- 服务端参数（启动时探测快照）：`max_model_len = 262,144`，KV cache 容量探测值 `693,413 token`（该口径与实测行为的矛盾见 §8）
- 测试 Profile：输入长度"长"档（模板目标 ~8k token）、输出长度 200 token、并发 50、每 Thread 迭代 5 次
- 规模：50 case × 5 迭代 = 250 次流式调用，0 错误，总耗时 ~505s
- 数据来源：vLLM `/metrics` 5s 采样（vLLM 指标区汇总）+ Prometheus 快照时序（102 个采样点，`metrics.json`）

## 2. 原始数据

### 2.1 汇总指标（vLLM 指标区，终值差分）

| 指标 | 值 | 说明 |
|---|---|---|
| 累计输入 tokens | 1,888,008 | ÷250 次 = **7,552 token/次**，即"长"档真实规模 |
| 累计生成 tokens | 63,035 | ÷250 = 252 token/次，符合 200 token 输出设置 |
| 输入:输出 token 比 | **30 : 1** | 97% 的 token 工作量在输入端 |
| TTFT 均值 / p50 / p95 | 28.3s / 26.3s / 49.3s | p50、p95 为直方图拟合值 |
| TPOT 均值 | 0.282s/token | 逐 token 间隔 |
| 平均 Prefill 耗时 | **2.77s** | 单请求 prefill 阶段耗时（`request_prefill_time_seconds`） |
| 平均 Decode 耗时 | 70.7s | 单请求 decode 阶段总耗时 |
| 生成吞吐均值 | 123.7 tok/s | 对照：该环境纯 decode 能力 ~2000 tok/s（见 `comparation.md` §5） |
| KV cache 占用均值 | 87.5%（峰值 99.7%） | t≈80s 起长期钉在 ~100% |
| running / waiting 峰值 | 41 / 41 | 稳态 run≈40、wait≈10-15 |
| 前缀缓存命中率 | 0% | 名词池设计使 prompt 首块即分叉，预期内 |
| 累计抢占次数 | **40** | KV 耗尽触发 RECOMPUTE 抢占 |

### 2.2 时序形态（Prometheus 快照，节选）

```
t(s)  run wait  kv%  gen/s  preempt/s  ttft_p50  prefill_p50  decode_p50
   0    0    0   0.0      1      0.00        -            -           -
  20   10   40   0.2      4      0.00      7.5            -           -
  40   18   32   0.5     15      0.00     22.0            -           -
  60   26   24   0.7     33      0.00     31.4            -           -
  80   39   11   1.0    114      0.04     60.0          2.5        90.0
 100   35   15   0.9    135      0.08     63.3          3.8        87.0
 120   38   12   0.9    147      0.11     36.0          3.8        90.0
 160   40    9   1.0    121      0.09     30.0          3.4        90.0
 240   39   11   1.0    113      0.02     30.0          3.0        90.0
 320   40   10   1.0    121      0.16     30.0          2.9        90.0
 400   41    9   1.0    112      0.13     30.0          2.5        90.0
 500   40    1   1.0    118      0.04     30.0          2.5        90.0
```

关键特征：

1. **prefill_p50 全程仅 2.5~3.8s**——单条请求的 prefill 计算本身并不慢；
2. **KV 从 t≈80s 起钉在 ~100%**，抢占速率 0.02~0.16 条/s 断续发生（共 40 次）；
3. **生成吞吐全程压在 ~110-150 tok/s**，远低于该环境 ~2000 tok/s 的 decode 上限；
4. 稳态 run≈40 / wait≈10-15：每条请求完成即有新请求准入，带入新的 7.5k prefill——**prefill 工作贯穿整轮测试从未停止**。waiting 取值来自 `metrics.json` 的 `num_requests_waiting` 序列（Prometheus 5s 采样，共 102 点）：稳态段（t≈80s 后）原始值在 9~15 间波动（9/10/11/12/13/14/15 交替），开局 40→32→24→16→11 的爬坡即 50 并发全部涌入后的队列消化过程。

## 3. 原理：两阶段负载的物理特性

理解本次现象的前提是 prefill 与 decode 在计算特性上的根本差异：

| 维度 | Prefill（处理输入） | Decode（逐 token 生成） |
|---|---|---|
| 计算特性 | **计算密集**：一次并行算完整个 prompt 的注意力 | **访存密集**：每步只算 1 个 token，瓶颈在权重与 KV 读取 |
| 并行方式 | 长 prompt 被切成 chunk **串行**处理（chunked prefill） | 批内所有序列**同步**各出 1 个 token，批大小近乎免费 |
| 单位成本 | 每 token 都要真算（FLOPs 与 prompt 长度成正比） | 每 token 只需一次前向，与批内其他请求共享计算 |
| 对他人的影响 | 占用引擎步，**挤占**同批 decode 的推进 | 批内 decode 互相几乎无影响 |
| KV 占用 | 准入即需一次性写入 prompt 全长的 KV | 随生成线性增长 |
| 排队代价 | 排队时间全部计入 **TTFT** | 不排队，但引擎步被 prefill 拖慢则体现在 **TPOT** |

**引擎步（engine step）**：vLLM 采用 continuous batching，引擎主循环每次迭代调度一个混合 batch 做一次前向传播，一次迭代即一个"引擎步"。chunked prefill 开启时（vLLM 0.27.x 默认），一个引擎步的 batch = 若干条 decode 序列（**每条只出 1 个 token**）+ 一条请求的一块 prefill chunk（如 2048 token）。由此：

- 步长 = 该次前向的耗时，prefill chunk 越大步长越长；
- decode 序列的逐 token 间隔 = 步长——这就是"TPOT 被 prefill chunk 锚定"的机制；
- 若 prefill 流不断，decode 永远等不到"纯 decode 短步"。

因此**只要 prefill 流不断，decode 的推进节奏就被锚定在 prefill chunk 的耗时上**——这是本次 TPOT 恶化的机制基础。（引擎步为 vLLM scheduler 主循环的公开设计，参见 vLLM 论文 Kwon et al., SOSP'23 及官方文档。）

## 4. 逐问分析

### Q1：TTFT ~20-30s 是"自己的 prefill 解析了 20s"吗？——不是

单条请求的 prefill 只要 ~3s（`prefill_avg_s = 2.77s`，时序 p50 2.5~3.8s）。TTFT 的真实构成：

```
TTFT ≈ 排队等其他请求的 prefill（~17-25s） + 自己的 prefill（~3s）
```

排队的数学验证：引擎聚合 prefill 吞吐 ≈ (1.888M 输入 + 40 次抢占重算 × 7.5k) ÷ 505s ≈ **4.3k token/s**。稳态 waiting 维持 10~15 条，每条都需 7.5k token 的 prefill，排在前面的请求按序消耗引擎吞吐：

```
10 条 × 7,552 token ÷ 4,300 token/s ≈ 17.6s（排队） + 2.8s（自身 prefill） ≈ 20s
```

与 TTFT p50 26.3s、均值 28.3s 吻合（waiting 峰值时段的请求等待更长，对应 p95 49.3s）。

**prefill 吞吐 4.3k tok/s 的出处**：vLLM `/metrics` 没有直接的 prefill 吞吐指标，此为推导值（整轮平均速率）：

```
(prompt_tokens_total 1,888,008 + preemptions_total 40 × 7,552) ÷ 505s ≈ 4,337 tok/s
```

分子包含 40 次抢占重算的 ~30 万 token——它们同样消耗 prefill 算力，故计入。前两项为 `result.json` 服务端计数器终值，时间窗 505s 来自 `metrics.json` 采样区间。该推导与 TTFT 观测自洽：队首 ~10 条 × 7.5k ÷ 4.3k ≈ 17.5s 排队 + 2.8s 自身 prefill ≈ 20s。

**结论**：prefill 压力大是对的，但压力的体现形式是**整批请求的 prefill 在引擎里串行排队**，而不是单条 prefill 变慢。时序上 TTFT 从开局 7.5s 爬到稳态 30s 的过程，正是 waiting 队列从 0 积压到 10-15 条的过程。

### Q2：TPOT ~282ms 是 KV 满触发抢占导致的吗？——抢占是次因，主因是 decode 被 prefill 挤占

**主因：chunked prefill 下 decode 步持续被 prefill chunk 挤占。** 证据：

1. 生成吞吐全程 ~120 tok/s，而该环境 40 条批 decode 的裸能力约 1500-2000 tok/s——decode 步只分到了引擎约 1/15 的步数。该能力区间为**推断值**（40 并发纯 decode 未直接测过），由两个独立证据夹逼：**上限**来自 `comparation.md` §5 同环境多轮测试的引擎吞吐收敛值（峰值 1992/2045 tok/s、均值 1744~1842 tok/s，100~200 并发满批）；**下限**来自短输入场景的 TPOT 基线 29.7~31.7ms（decode 不被挤占时的实测值），40 条 × 1/0.03s ≈ 1330 tok/s。关键论点对此区间不敏感：本次实测 124 tok/s 比下限估计还低一个数量级；
2. prefill 工作贯穿全程（稳态 run≈40/wait≈10-15，完成一条准入一条，新准入即带 7.5k prefill），decode 从未获得"纯 decode 窗口"；
3. TPOT ≈ 引擎步长 ≈ prefill chunk 耗时，与观测的 282ms 量级一致。

**次因：抢占的放大效应。** 40 次抢占摊到 63k 生成 token 上，直接贡献仅 ~10-20ms/token，量级不足以解释 282ms。但每次抢占产生两个间接代价：

- 被抢占请求需**重新全量 prefill 7.5k token**（40 次 × 7.5k ≈ 30 万 token 额外 prefill，加剧对 decode 的挤占）；
- 被抢占请求出现秒级生成停顿，拉高 TPOT 长尾。

两个因素同根同源：**8k 输入 × 50 并发**——KV 逼近上限引发抢占，持续准入引发持续 prefill。

### Q3：prefill 8k/decode 200 与 prefill 200/decode 8k 的结果相似吗？——完全不同

两种负载每条请求的 token 总量相同（~8.2k），但物理特性截然不同，预测对比如下：

| 指标 | A：输入 8k / 输出 200（本次实测） | B：输入 200 / 输出 8k（预测） |
|---|---|---|
| TTFT | ~28s（prefill 排队主导） | **<1s**（prefill 秒完，无排队） |
| TPOT | ~282ms（被 prefill 挤占） | **~15-40ms**（纯 decode 步，接近该环境 29-32ms 基线） |
| 平均 Prefill 耗时/条 | 2.77s | ~0.01s |
| 平均 Decode 耗时/条 | 70.7s | ~160-320s（8k token × 20-40ms） |
| 生成吞吐 | ~124 tok/s | **~1500-2000 tok/s**（贴近硬件上限） |
| KV 峰值形态 | 开局即近满（准入即占 7.5k） | 随生成线性爬升，后期才紧张 |
| 抢占重算代价 | 7.5k token/次（昂贵） | 仅 200+已生成 token/次（廉价） |
| 瓶颈类型 | 计算密集（prefill 排队） | 访存密集（KV 容量后期） |

本质：**prefill 是计算密集、必须分块串行的**——排队推高 TTFT，且持续挤占他人 decode；**decode 是访存密集、批处理近乎免费的**——40 条一起出 token 的成本和 1 条差不多。因此同样 8.2k token，放在输入端是"30 倍于输出的计算量 + 串行排队"，放在输出端是"批内摊薄的访存 + 并行推进"。

B 场景唯一的隐患是后期 KV 也可能满（50 × 8.2k ≈ 410k，若池容量 ~310k 则后期触发抢占），但抢占重算代价仅 ~200+已生成 token，TPOT 只会轻微抖动，不会出现 A 场景的全面恶化。

验证方式：输入选"短"档、输出填 8000 token、并发 50（UI 输出长度上限 10000，可直接跑）。该上限指测试配置面板"输出长度（token）"输入框的约束，前后端双重限制：前端 `app/static/index.html` 的 `articleLength` 输入框 `max="10000"`，后端 `app/main.py` 对 `article_length > 10000` 直接返回"输出长度需在 10-10000 token 之间"。预期 TTFT 亚秒级、TPOT ~20ms 量级，监控区 Prefill/Decode 双轴图中 prefill 贴零、decode ~200s。

## 5. 附：thread 详情中输入长度"看起来很短"的原因

分析本测试时曾出现"每条对话输入只有 200-300 字，没有 follow profile"的疑问，实为**存储截断的显示效果**，非测试未按 profile 执行：

- 实际发送的 prompt 为完整长档模板：每条 **13,193 字 ≈ 7.5k token**（服务端 `prompt_tokens_total` 1,888,008 ÷ 250 次 = 7,552 token/次，交叉验证一致）；
- 落盘时 `truncate_for_store`（`app/prompt_templates.py`）对超长 prompt 只保留首 300 字 + 尾 200 字，中间以"……[中间 N 字已省略]……"标记替代——防止 result.json 膨胀（50 case × 5 迭代 × 1.3 万字 ≈ 3.3MB 纯问题文本）；
- 详情弹窗展示的 531 字 = 300（头）+ 200（尾）+ 31（标记），截断标记夹在问题文本中段，不细看容易漏掉。

**已修复**（2026-08-31）：QA 记录新增 `prompt_chars` 字段存截断前真实长度，详情头部显示"输入 13,193 字（≈7.6K token）"；旧任务无该字段时回退解析截断标记（首 300 + 尾 200 + 省略 N 字）推算。

## 6. 遗留问题：KV 容量探测口径与实测行为矛盾

探测报 KV 容量 **693,413 token**，但实测 ~40 条 × 7.7k ≈ 310k token 时 `gpu_cache_usage` 即达 ~100% 并触发抢占，两者差约 2 倍：

- 探测读的是 `/metrics` 的 `kv_cache_size_tokens` label（`app/llm_client.py::probe_vllm_params`）；
- `gpu_cache_usage` 的分母是引擎实际分配的 KV 池，可能因 tensor 并行（TP）下按单卡口径统计、或 `gpu_memory_utilization` 划分后的实际池小于 label 声明值；
- **影响**：并发度预估（`KV 容量 ÷ (输入+输出)`）按 693k 会预估 ~89 并发，实际 ~40 并发即打满，预估偏乐观约 2 倍。

待核查项：确认该 vLLM 版本两个口径的定义差异（是否 TP 数量级、是否含 CPU offload 部分），必要时修正探测算法或预估公式。

## 7. 结论汇总

1. **TTFT 28s ≠ 单条 prefill 慢**：单条 prefill 仅 2.77s，其余 ~25s 是排队等其他请求的 prefill（引擎聚合 prefill 吞吐 ~4.3k tok/s，队首 10 条 × 7.5k ÷ 4.3k ≈ 17s）。压力形式是"整批 prefill 串行排队"，不是"单条解析变慢"。
2. **TPOT 282ms 的主因是 decode 被 prefill 持续挤占**（chunked prefill 模式下引擎步被 prefill chunk 锚定，生成吞吐仅 124 tok/s，为 decode 裸能力的 ~1/15）；抢占（40 次）是次因与放大器（贡献 ~10-20ms/token，但每次抢占额外产生 7.5k token 重复 prefill 并造成秒级停顿长尾）。
3. **输入 8k/输出 200 与输入 200/输出 8k 完全不等价**：prefill 计算密集须串行排队（摧毁 TTFT 并拖累全局 decode），decode 访存密集批处理近乎免费（吞吐贴近上限、TPOT 接近基线）。同样的 token 预算，从输入端移到输出端，TTFT 预计从 ~28s 降至亚秒，TPOT 从 282ms 降至 ~20-40ms，吞吐从 124 升至 ~2000 tok/s。
4. **输入:输出 = 30:1 是本次性能形态的根源**：97% 的 token 工作量集中在 prefill 端，系统实质上在跑一个"prefill 吞吐基准"而非"生成基准"。
5. thread 详情中的"短输入"是存储截断的显示效果，测试本身严格按 profile 执行（服务端 token 计数交叉验证一致）。

## 8. 建议

1. **评估长输入场景时以 prefill 吞吐为核心指标**：该环境聚合 prefill 吞吐 ~4.3k tok/s，长输入高并发的 TTFT 上限 ≈ 队列深度 × 单条输入 token ÷ prefill 吞吐，与 decode 能力无关；
2. **压测长输入时控制并发或分批准入**：50 并发 × 7.5k 输入使 KV 开局即满、抢占频发；将并发降至 KV 容量 ÷ 单请求输入（按实测 ~310k 口径约 40，按探测 693k 约 89，建议以实测为准）可消除抢占；
3. **对比实验**：跑一次"短输入 / 8000 输出 / 50 并发"验证 §4 Q3 的预测，两轮报告对照即可直观展示 prefill 主导与 decode 主导负载的形态差异；
4. **核查 KV 容量探测口径**（§6），修正并发度预估，避免按偏乐观容量规划压测参数；
5. **解读报告时先看输入:输出 token 比**：比值 ≥10:1 时，TTFT/TPOT/吞吐的异常应优先从 prefill 排队与挤占解释，而非 decode 能力。

