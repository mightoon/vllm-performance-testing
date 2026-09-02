# LLM 测试平台

基于 FastAPI 的大模型测试 Web 应用。

## 功能

- **多测试 Tab**：文本测试（已实现）、图形测试 / 综合测试（占位）
- **模型配置管理**（右上角 ⚙ 设置）：
  - 填写模型名称、模型 ID、Base URL、API Key（可选）
  - 测试连接 → 验证通过后保存，持久化到 `config.json`（API Key Base64 编码存储）
  - 配置列表支持修改 / 删除
- **文本测试**：
  - 每个 case 先让模型生成 N 个名词，再循环为每个名词生成指定字数的文章
  - 可控参数：名词数量、文章篇幅、并发度（并行 case 数）
  - 运行区每个 case 一条水平进度条，颜色填充显示循环进度
  - 刷新间隔可选 1/3/5/10/30 秒或自定义

## 运行

### 方式一：python run.py（推荐，端口读配置）

```bash
pip install -r requirements.txt
python run.py
```

服务端口在 `config.json` → `server.port` 中配置（默认 5888，非法或缺失时自动回退默认值）：

```json
{
  "server": { "port": 5888 },
  "log": { "enabled": false },
  "models": [],
  "prometheus": { "url": "", "grafana_url": "" }
}
```

### 日志开关（排查问题用）

`config.json` → `log.enabled` 改为 `true` 后**即时生效（无需重启）**，记录：
每次 `/api/` 请求（方法/路径/状态/耗时）、每次大模型调用（chat/probe，
含耗时与结果）、测试生命周期（启动/结束/case 状态）、Prometheus 快照、
AI 分析生成过程（开始/模型调用/落盘/失败原因）等。

日志文件：`logs/app.log`（exe 同目录或项目根目录，1MB × 5 轮转，UTF-8）。

### 方式二：python -m uvicorn 直接启动（端口由命令行指定）

```bash
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 5888
```

浏览器访问 http://127.0.0.1:5888

### 打包为可执行文件（免 Python 环境运行）

```bash
pip install pyinstaller
pyinstaller llm_test.spec --noconfirm
```

生成的 `dist/llm_test.exe` 可直接复制到其他 Windows 机器运行。首次运行会在 exe 同目录自动生成 `config.json` 和 `workspace/`，修改端口只需编辑该 `config.json` 后重启。

## 目录结构

```
app/
  main.py          # FastAPI 入口（模型管理 + 测试 API + 静态页面）
  model_store.py   # 配置持久化（config.json）
  llm_client.py    # OpenAI 兼容 API 客户端（含千问 thinking 禁用）
  test_engine.py   # 文本测试执行引擎（并发 case + 进度跟踪）
  static/          # 前端（index.html / style.css / app.js）
config.json        # 模型配置（运行后自动生成）
```

## API 摘要

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/models | 配置列表 |
| POST | /api/models | 新增配置 |
| PUT | /api/models/{id} | 修改配置 |
| DELETE | /api/models/{id} | 删除配置 |
| GET | /api/models/{id}/apikey | 获取解码后 Key（编辑用） |
| POST | /api/verify-model | 测试连接 |
| POST | /api/tests/text/start | 启动文本测试 |
| GET | /api/tests/text/status | 查询进度 |
| POST | /api/tests/text/stop | 停止测试 |
