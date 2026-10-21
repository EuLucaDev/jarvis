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


# ---------- mais ações do Mac ----------

HOME = Path.home()
PLACES = {
    "mesa": HOME / "Desktop", "área de trabalho": HOME / "Desktop", "desktop": HOME / "Desktop",
    "documentos": HOME / "Documents", "downloads": HOME / "Downloads", "imagens": HOME / "Pictures",
    "fotos": HOME / "Pictures", "músicas": HOME / "Music", "filmes": HOME / "Movies",
}


def _resolve(caminho: str, must_exist: bool = True) -> Path | None:
    """Converte 'Downloads/relatórios' ou 'Projetos' (na Mesa) em um caminho dentro da pasta pessoal."""
    raw = caminho.strip().strip("/").replace("~/", "")
    first, _, rest = raw.partition("/")
    base = PLACES.get(first.lower())
    p = (base / rest) if base else (HOME / "Desktop" / raw)
    if must_exist and not p.exists():
        alt = HOME / raw
        p = alt if alt.exists() else p
    p = p.resolve()
    if HOME.resolve() not in p.parents and p != HOME.resolve():
        return None  # nada fora da pasta pessoal
    return p if (p.exists() or not must_exist) else None


def lock_screen() -> dict[str, Any]:
    _run(["pmset", "displaysleepnow"])
    return {"ok": True}


def brightness(nivel: int) -> dict[str, Any]:
    if not shutil.which("brightness"):
        return {"erro": "Instale o utilitário: brew install brightness"}
    nivel = max(5, min(100, int(nivel)))
    r = _run(["brightness", f"{nivel / 100:.2f}"])
    return {"ok": r.returncode == 0, "brilho": nivel}


def create_reminder(texto: str, quando: str | None = None, lista: str | None = None) -> dict[str, Any]:
    """Lembrete no app Lembretes (sincroniza com o iPhone pelo iCloud). `quando` em ISO 2026-10-22T09:00."""
    esc = texto.replace('"', "'")
    props = f'name:"{esc}"'
    script = []
    if quando:
        import datetime as _dt

        try:
            d = _dt.datetime.fromisoformat(quando)
        except ValueError:
            return {"erro": "Data inválida; use AAAA-MM-DDTHH:MM."}
        script += [
            "set d to current date",
            f"set year of d to {d.year}", f"set month of d to {d.month}", f"set day of d to {d.day}",
            f"set hours of d to {d.hour}", f"set minutes of d to {d.minute}", "set seconds of d to 0",
        ]
        props += ", remind me date:d"
    target = f'list "{lista}"' if lista else "default list"
    script.append(f'tell application "Reminders" to make new reminder at end of {target} with properties {{{props}}}')
    r = _run(["osascript", *sum((["-e", line] for line in script), [])])
    if r.returncode != 0:
        return {"erro": r.stderr.strip()[:200]}
    return {"ok": True, "lembrete": texto, "quando": quando}


def create_folder(caminho: str) -> dict[str, Any]:
    p = _resolve(caminho, must_exist=False)
    if not p:
        return {"erro": "Só crio pastas dentro da sua pasta pessoal."}
    p.mkdir(parents=True, exist_ok=True)
    return {"ok": True, "pasta": str(p).replace(str(HOME), "~")}


def open_folder(caminho: str) -> dict[str, Any]:
    p = _resolve(caminho)
    if not p:
        return {"erro": f"Não encontrei '{caminho}'."}
    _run(["open", str(p)])
    return {"ok": True, "aberto": str(p).replace(str(HOME), "~")}


def find_file(nome: str, abrir: bool = True) -> dict[str, Any]:
    r = _run(["mdfind", "-onlyin", str(HOME), "-name", nome], timeout=20)
    hits = [h for h in r.stdout.splitlines() if "/Library/" not in h and "/." not in h][:8]
    if not hits:
        return {"erro": f"Nenhum arquivo com '{nome}' no nome."}
    if abrir:
        _run(["open", hits[0]])
    return {"ok": True, "aberto": hits[0].replace(str(HOME), "~") if abrir else None, "encontrados": [h.replace(str(HOME), "~") for h in hits]}


KINDS = {
    "Imagens": {".jpg", ".jpeg", ".png", ".gif", ".heic", ".webp", ".svg", ".tiff"},
    "Documentos": {".pdf", ".doc", ".docx", ".txt", ".rtf", ".pages", ".md", ".odt"},
    "Planilhas": {".xls", ".xlsx", ".csv", ".numbers"},
    "Apresentações": {".ppt", ".pptx", ".key"},
    "Vídeos": {".mp4", ".mov", ".avi", ".mkv", ".m4v"},
    "Áudios": {".mp3", ".wav", ".m4a", ".aac", ".flac"},
    "Compactados": {".zip", ".rar", ".7z", ".tar", ".gz", ".dmg"},
    "Design": {".psd", ".ai", ".fig", ".sketch", ".indd", ".aep", ".prproj", ".blend"},
}


def organize_folder(caminho: str, confirmado: bool = False) -> dict[str, Any]:
    p = _resolve(caminho)
    if not p or not p.is_dir():
        return {"erro": f"Pasta '{caminho}' não encontrada."}
    plan: dict[str, int] = {}
    files = [f for f in p.iterdir() if f.is_file() and not f.name.startswith(".")]
    for f in files:
        kind = next((k for k, exts in KINDS.items() if f.suffix.lower() in exts), "Outros")
        plan[kind] = plan.get(kind, 0) + 1
    if not confirmado:
        return {"precisa_confirmar": True, "pasta": str(p).replace(str(HOME), "~"), "plano": plan,
                "instrucao": "Diga o plano em uma frase e pergunte se pode organizar. Só chame de novo com confirmado=true se ele disser sim."}
    for f in files:
        kind = next((k for k, exts in KINDS.items() if f.suffix.lower() in exts), "Outros")
        dest = p / kind
        dest.mkdir(exist_ok=True)
        target = dest / f.name
        if not target.exists():
            f.rename(target)
    return {"ok": True, "organizados": plan}


def zip_folder(caminho: str) -> dict[str, Any]:
    p = _resolve(caminho)
    if not p or not p.is_dir():
        return {"erro": f"Pasta '{caminho}' não encontrada."}
    out = shutil.make_archive(str(p), "zip", root_dir=p.parent, base_dir=p.name)
    return {"ok": True, "arquivo": out.replace(str(HOME), "~")}


def trash_item(caminho: str, confirmado: bool = False) -> dict[str, Any]:
    p = _resolve(caminho)
    if not p:
        return {"erro": f"Não encontrei '{caminho}'."}
    if p in PLACES.values() or p == HOME.resolve():
        return {"erro": "Não apago pastas do sistema."}
    if not confirmado:
        return {"precisa_confirmar": True, "item": str(p).replace(str(HOME), "~"),
                "instrucao": "Pergunte se pode mandar para a Lixeira. Só chame de novo com confirmado=true se ele disser sim."}
    r = _run(["osascript", "-e", f'tell application "Finder" to delete (POSIX file "{p}" as alias)'])
    if r.returncode != 0:
        return {"erro": r.stderr.strip()[:200]}
    return {"ok": True, "na_lixeira": str(p).replace(str(HOME), "~")}


# ---------- Alexa via Voice Monkey ----------


def alexa(dispositivo: str, acao: str) -> dict[str, Any]:
    cfg = store.get("alexa") or {}
    token = cfg.get("token")
    if not token:
        return {"erro": "Alexa não configurada. Cole o token do Voice Monkey em Painel → Conexões → Alexa."}
    devs = cfg.get("dispositivos") or []
    names = [d.get("nome", "") for d in devs]
    key = dispositivo.lower().strip()
    dev = next((d for d in devs if d.get("nome", "").lower() == key), None)
    if not dev:
        close = difflib.get_close_matches(key, [n.lower() for n in names], n=1, cutoff=0.5)
        dev = next((d for d in devs if close and d.get("nome", "").lower() == close[0]), None)
    if not dev:
        return {"erro": f"Dispositivo '{dispositivo}' não cadastrado.", "cadastrados": names}
    monkey = dev.get("ligar" if acao == "ligar" else "desligar")
    if not monkey:
        return {"erro": f"O dispositivo {dev['nome']} não tem rotina para {acao}."}
    for param in ("device", "monkey"):
        try:
            r = httpx.get("https://api-v2.voicemonkey.io/trigger", params={"token": token, param: monkey}, timeout=10)
            if r.status_code == 200 and r.json().get("success"):
                return {"ok": True, "dispositivo": dev["nome"], "acao": acao}
        except Exception as exc:  # noqa: BLE001
            last = str(exc)
        else:
            last = r.text[:160]
    return {"erro": f"O Voice Monkey recusou: {last}"}
