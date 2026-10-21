"""Mac: telemetria, controle do computador por ações permitidas e câmeras.

O controle do computador é uma lista fechada de ações (abrir app, abrir link, mídia, volume,
rodar um Atalho do macOS). Não existe execução de comando livre. Atalhos são a ponte para o
celular, a Casa (HomeKit) e outros serviços: o Jarvis só roda os nomes liberados no painel.
"""

import asyncio
import difflib
import logging
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx
import psutil

from . import store

log = logging.getLogger("jarvis.system")

# ---------- telemetria ----------

_net = {"t": time.time(), "sent": 0, "recv": 0}


def telemetry() -> dict[str, Any]:
    now = time.time()
    io = psutil.net_io_counters()
    dt = max(0.5, now - _net["t"])
    down = (io.bytes_recv - _net["recv"]) / dt / 1024 if _net["recv"] else 0
    up = (io.bytes_sent - _net["sent"]) / dt / 1024 if _net["sent"] else 0
    _net.update(t=now, sent=io.bytes_sent, recv=io.bytes_recv)
    bat = psutil.sensors_battery()
    disk = psutil.disk_usage("/")
    return {
        "cpu": round(psutil.cpu_percent(interval=None)),
        "ram": round(psutil.virtual_memory().percent),
        "disco": round(disk.percent),
        "rede_kbps": {"down": round(down), "up": round(up)},
        "bateria": round(bat.percent) if bat else None,
        "carregando": bat.power_plugged if bat else None,
        "uptime_h": round((now - psutil.boot_time()) / 3600, 1),
    }


# ---------- computador ----------


def _apps() -> dict[str, str]:
    found: dict[str, str] = {}
    for base in ("/Applications", "/System/Applications", "/System/Applications/Utilities", str(Path.home() / "Applications")):
        p = Path(base)
        if p.exists():
            for app in p.glob("*.app"):
                found[app.stem.lower()] = app.stem
    return found


def _run(cmd: list[str], timeout: int = 15) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def open_app(nome: str) -> dict[str, Any]:
    apps = _apps()
    key = nome.lower().strip()
    match = apps.get(key) or next((v for k, v in apps.items() if key in k), None)
    if not match:
        close = difflib.get_close_matches(key, list(apps), n=1, cutoff=0.6)
        match = apps[close[0]] if close else None
    if not match:
        return {"erro": f"Não encontrei o app {nome}."}
    r = _run(["open", "-a", match])
    return {"ok": r.returncode == 0, "app": match} if r.returncode == 0 else {"erro": r.stderr.strip()[:200]}


def open_link(url: str) -> dict[str, Any]:
    if not url.startswith(("http://", "https://")):
        url = "https://" + url.lstrip("/")
    r = _run(["open", url])
    return {"ok": r.returncode == 0, "url": url}


def media(acao: str) -> dict[str, Any]:
    cmd = {"tocar_pausar": "playpause", "proxima": "next track", "anterior": "previous track"}.get(acao)
    if not cmd:
        return {"erro": "Ação de mídia desconhecida."}
    for app in ("Spotify", "Music"):
        running = _run(["osascript", "-e", f'application "{app}" is running']).stdout.strip() == "true"
        if running:
            _run(["osascript", "-e", f'tell application "{app}" to {cmd}'])
            return {"ok": True, "app": app}
    return {"erro": "Nenhum player aberto (Spotify ou Música)."}


def volume(nivel: int) -> dict[str, Any]:
    nivel = max(0, min(100, int(nivel)))
    _run(["osascript", "-e", f"set volume output volume {nivel}"])
    return {"ok": True, "volume": nivel}


def shortcuts_available() -> list[str]:
    if not shutil.which("shortcuts"):
        return []
    r = _run(["shortcuts", "list"])
    return [s.strip() for s in r.stdout.splitlines() if s.strip()]


def run_shortcut(nome: str, entrada: str | None = None) -> dict[str, Any]:
    allowed = store.get("atalhos") or []
    match = next((a for a in allowed if a.lower() == nome.lower()), None)
    if not match:
        close = difflib.get_close_matches(nome, allowed, n=1, cutoff=0.6)
        match = close[0] if close else None
    if not match:
        return {"erro": f"O atalho '{nome}' não está liberado. Libere em Ajustes → Atalhos.", "liberados": allowed}
    cmd = ["shortcuts", "run", match]
    proc = subprocess.run(cmd, input=entrada or "", capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        return {"erro": proc.stderr.strip()[:200] or "O atalho falhou."}
    return {"ok": True, "atalho": match, "saida": proc.stdout.strip()[:500]}


# ---------- câmeras ----------


def cameras() -> list[dict[str, str]]:
    return store.get("cameras") or []


def find_camera(nome: str) -> dict[str, str] | None:
    cams = cameras()
    key = nome.lower().strip()
    return next((c for c in cams if key in (c.get("nome", "").lower(), c.get("id", "").lower())), None) or next(
        (c for c in cams if key in c.get("nome", "").lower()), None
    )


async def snapshot(cam: dict[str, str]) -> bytes:
    url = cam["url"]
    if url.startswith(("rtsp://", "rtsps://")):
        if not shutil.which("ffmpeg"):
            raise RuntimeError("ffmpeg não instalado (brew install ffmpeg).")
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", url,
            "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-f", "image2", "-c:v", "mjpeg", "pipe:1",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), 20)
        if not out:
            raise RuntimeError(err.decode()[:200] or "Câmera não respondeu.")
        return out
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as http:
        r = await http.get(url)
        r.raise_for_status()
        return r.content
