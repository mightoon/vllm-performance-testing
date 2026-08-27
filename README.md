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

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

浏览器访问 http://127.0.0.1:8000

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
