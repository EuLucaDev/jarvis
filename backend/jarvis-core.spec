# PyInstaller: empacota o núcleo do Jarvis numa pasta (jarvis-core/) com o Python, as bibliotecas, os
# modelos (voz offline e mãos) e a interface compilada. O app Tauri leva essa pasta e abre o executável.
#   uv run --group build pyinstaller jarvis-core.spec --noconfirm
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

ROOT = Path(SPECPATH).resolve().parent  # noqa: F821 - SPECPATH vem do PyInstaller

datas = [
    (str(ROOT / "frontend" / "dist"), "web"),
    (str(ROOT / "backend" / "models"), "models"),
    (str(ROOT / "VERSION"), "."),
]
# financeiro: o motor (Node + regras da Carteira + dependências) e o próprio Node, se a compilação trouxe
if (ROOT / "financeiro" / "motor" / "node_modules").exists():
    for item in ("servidor.js", "catalogo.js", "package.json", "db", "node_modules", "tessdata"):
        if (ROOT / "financeiro" / "motor" / item).exists():
            alvo = "financeiro" if item.endswith((".js", ".json")) else f"financeiro/{item}"
            datas.append((str(ROOT / "financeiro" / "motor" / item), alvo))
if (ROOT / "backend" / "node-bin").exists():
    datas.append((str(ROOT / "backend" / "node-bin"), "node"))
binaries = []
hiddenimports = collect_submodules("jarvis") + ["uvicorn.logging", "uvicorn.loops.auto", "uvicorn.protocols.http.auto",
                                                "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on"]

for pkg in ("mediapipe", "rtmlib", "onnxruntime", "vosk", "sounddevice", "_sounddevice_data", "google.genai", "ddgs", "certifi", "icalendar",
            "recurring_ical_events", "pynput", "mss", "send2trash"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:  # noqa: BLE001 - pacote opcional neste sistema
        pass

if sys.platform == "darwin":
    hiddenimports += ["AppKit", "Quartz", "ApplicationServices", "Foundation", "objc", "PyObjCTools.AppHelper", "Vision", "CoreML"]
elif sys.platform == "win32":
    hiddenimports += ["win32gui", "win32con", "win32api", "win32process", "win32clipboard", "pycaw.pycaw", "comtypes",
                      "screen_brightness_control", "uiautomation"]
    datas += collect_data_files("screen_brightness_control")

a = Analysis(  # noqa: F821
    [str(ROOT / "backend" / "run_core.py")],
    pathex=[str(ROOT / "backend")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "PyQt5", "PySide6", "IPython", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)  # noqa: F821
exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="jarvis-core",
    console=sys.platform != "win32",  # no Windows, sem janela preta
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="jarvis-core", upx=False)  # noqa: F821
