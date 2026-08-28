# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec —— 将 LLM 测试平台打包为单个 .exe 文件。"""

import os
import sys
from pathlib import Path

# ---- 静态文件收集 ----
PROJECT_ROOT = Path(SPECPATH)
STATIC_DIR = PROJECT_ROOT / "app" / "static"

static_datas = []
for f in STATIC_DIR.iterdir():
    if f.is_file():
        dest = os.path.join("app", "static")
        static_datas.append((str(f), dest))

# config.json 打包到根目录（首次运行时会复制到 exe 所在目录）
static_datas.append((str(PROJECT_ROOT / "config.json"), "."))

# ---- uvicorn 隐式导入 ----
# uvicorn 使用 importlib 动态加载 worker，PyInstaller 无法自动检测
hidden_imports = [
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.loops.uvloop",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "fastapi",
    "starlette",
    "pydantic",
    "httpx",
    "httpcore",
    "h11",
    "anyio",
    "sniffio",
    "click",
]

a = Analysis(
    ["run.py"],
    pathex=[str(PROJECT_ROOT)],
    binaries=[],
    datas=static_datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "unittest",
        "pydoc",
        "distutils",
        "setuptools",
        "pip",
        "pkg_resources",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=None,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=None)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="llm_test",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)