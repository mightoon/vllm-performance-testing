"""LLM 测试平台 - PyInstaller / Python 通用入口。"""
import uvicorn

# PyInstaller 无法通过字符串引用检测到 app 包，需要显式导入
import app.main  # noqa: F401
from app.model_store import get_server_port


def main():
    port = get_server_port()
    print(f"服务启动于 http://0.0.0.0:{port}（端口可在 config.json → server.port 修改）")
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=port,
        log_level="info",
    )


if __name__ == "__main__":
    main()