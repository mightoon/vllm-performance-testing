# LLM 请求参数说明：max_tokens 的来源与影响

本文档解释日志中 LLM 调用记录的各字段含义，重点说明 `max_tokens=2048` 的计算逻辑，及其对长上下文测试的影响。

日志示例（`app/llm_client.py` 中 `chat_completion` / `chat_completion_stream` 发起请求时打印）：

```
2026-09-02 18:26:34 [llm] chat_stream 开始 model=qwen38-27b url=http://192.168.100.242:10138/v1/chat/completions messages=1 prompt_chars=181 max_tokens=2048
```

| 字段 | 含义 |
|---|---|
| `model` | 请求的模型名（config.json 中配置的 `model`） |
| `url` | 完整请求地址（配置的 `url` + `/chat/completions`） |
| `messages` | 消息条数（图片/视频测试为 1 条多模态 user 消息） |
| `prompt_chars` | 输入文本字符数（不含图片/视频等多模态内容，仅统计字符串部分） |
| `max_tokens` | **输出** token 上限，见下文 |

---

## 1. max_tokens 的计算公式

三种测试引擎（文本/图形/视频）发起生成请求时，`max_tokens` 均按同一公式计算：

```python
max_tokens = max(2048, int(article_length * 1.5))
```

- 代码位置：`app/test_engine.py`（文本）、`app/image_engine.py`（图形）、`app/video_engine.py`（视频）
- `article_length` 即页面上的"输出长度（token）"参数，默认 500，范围 10–10000
- **×1.5 余量**：模型实际输出可能略微超出目标字数，留 50% 余量防止文章被 `max_tokens` 截断
- **2048 下限**：输出长度设得较小时（≤1365，如默认 500 → 750），取下限 2048

因此日志中看到 `max_tokens=2048`，说明该次测试的输出长度参数较小，触发了下限——**不是代码写死的上限**。输出长度设 4000 时日志会显示 `max_tokens=6000`。

## 2. 对长上下文测试的影响

**`max_tokens` 只限制输出（生成）的 token 数，完全不限制输入。**

- 长上下文测试的输入（图片/视频的视觉编码 token + prompt 文本）不受 `max_tokens` 任何影响，服务端正常处理长 prefill
- 输入 token 的实际数量由服务端 usage 统计（`include_usage=True`），用于报告中的"平均输入 token"等指标

唯一的相关约束在**服务端**：vLLM 要求

```
输入 token 数 + max_tokens ≤ max_model_len
```

若输入特别长、同时输出长度又设得很大，服务端会返回 400 拒绝该请求。这是模型上下文窗口的固有限制，而非本系统的问题。模型管理中的"探测"功能（`app/llm_client.py::probe_server_info`）可探测出服务的 `max_model_len`，配置参数时可参考：**输出长度 ≤ max_model_len − 预期输入 token 数**。

## 3. 代码中其他 max_tokens 用途

除测试引擎外，还有几处独立的 `max_tokens` 设置，与测试请求互不影响：

| 场景 | 位置 | 值 | 说明 |
|---|---|---|---|
| 函数签名默认值 | `llm_client.py` 的 `chat_completion` / `chat_completion_stream` | 2048 | 仅作默认参数，测试引擎均显式传值覆盖 |
| 连接验证 | `llm_client.py::verify_connection` | 5 | 最小请求，只验证连通性/模型存在性 |
| AI 分析结论 | `analysis.py`（`_MAX_TOKENS`） | 1500 | 500 字中文结论的 token 上限，留足余量防截断 |
| max_model_len 探测 | `llm_client.py::probe_server_info` | 10000000 | 故意超大的试探请求，被服务端立即拒绝（不消耗 GPU），从错误信息中解析最大上下文长度 |

## 4. 其他请求级参数

测试引擎发起的生成请求还固定携带：

- `stream: True`：流式返回，边生成边统计首 token 延迟与逐 token 延迟
- `chat_template_kwargs: {"enable_thinking": False, "thinking": False}`：禁用思考过程，所有测试与问答均建立在关闭 thinking 的基础上
- `include_usage: True`（图形/视频）：流式请求附带 usage 统计，获取每请求精确输入 token 数
