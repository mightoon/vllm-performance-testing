"""PyInstaller / Python 双模式路径统一处理。

- 数据目录（config.json / workspace / 快照）：
  Python 模式 → 项目根目录
  PyInstaller → 可执行文件所在目录（用户可直接修改 config.json）

- 静态资源（前端文件）：
  Python 模式 → app/static/
  PyInstaller → sys._MEIPASS/app/static/（随 exe 打包，只读）
"""
import os
import sys


def is_frozen() -> bool:
    return getattr(sys, "frozen", False)


def data_root() -> str:
    """数据读写根目录：config.json、workspace/ 均在此目录下。"""
    if is_frozen():
        return os.path.dirname(sys.executable)
    # Python 模式：app/ 的上一级即项目根目录
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def static_dir() -> str:
    """前端静态资源目录（只读）。"""
    if is_frozen():
        return os.path.join(sys._MEIPASS, "app", "static")
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


def ensure_config() -> None:
    """PyInstaller 模式下，首次运行时将内置 config.json 复制到可执行文件目录，
    后续用户修改配置均保存在该副本中，不会丢失。
    """
    if not is_frozen():
        return
    dest = os.path.join(data_root(), "config.json")
    if os.path.exists(dest):
        return
    src = os.path.join(sys._MEIPASS, "config.json")
    if os.path.exists(src):
        import shutil
        os.makedirs(data_root(), exist_ok=True)
        shutil.copy2(src, dest)