"""Abre o HUD e as telas extras no Chrome, um por monitor, em tela cheia.

Cada janela usa um perfil próprio do Chrome (só para o Jarvis), o que permite várias janelas em
tela cheia ao mesmo tempo. O perfil do HUD libera microfone, câmera e som sem clique, porque o
Jarvis precisa ouvir e falar assim que o Mac liga; ele só abre o endereço local do Jarvis.

Uso: `python -m jarvis.launcher` (o LaunchAgent de login chama assim) ou POST /api/monitores/abrir.
"""

import json
import logging
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx

from . import store
from .config import settings

log = logging.getLogger("jarvis.launcher")

CHROME = "/Applications/Google Chrome.app"
PROFILES = Path.home() / "Library" / "Application Support" / "Jarvis"
JXA = """
ObjC.import('AppKit');
var s = $.NSScreen.screens, out = [];
for (var i = 0; i < s.count; i++) {
  var sc = s.objectAtIndex(i), f = sc.frame;
  out.push({nome: ObjC.unwrap(sc.localizedName), x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height});
}
JSON.stringify(out);
"""


def displays() -> list[dict[str, Any]]:
    """Monitores em coordenadas de tela (origem no canto superior esquerdo do principal)."""
    r = subprocess.run(["osascript", "-l", "JavaScript", "-e", JXA], capture_output=True, text=True, timeout=10)
    raw = json.loads(r.stdout or "[]")
    if not raw:
        return []
    main_h = raw[0]["h"]
    out = []
    for i, d in enumerate(raw):
        out.append({
            "indice": i,
            "nome": d["nome"],
            "principal": i == 0,
            "x": int(d["x"]),
            "y": int(main_h - (d["y"] + d["h"])),  # Cocoa mede de baixo para cima
            "w": int(d["w"]),
            "h": int(d["h"]),
            "em_pe": d["h"] > d["w"],
        })
    return out


def plan() -> list[dict[str, Any]]:
    """Qual tela vai em qual monitor. Padrão: só o HUD, no principal. Os outros monitores (inclusive a
    tela do notebook) ficam livres até o Luca escolher uma tela extra para eles no painel."""
    cfg = store.get("monitores") or {}
    mapa: dict[str, str] = cfg.get("mapa") or {}
    # com o app Jarvis instalado (avisou nos últimos 14 dias), o HUD é dele; aqui só as telas extras
    app = (store.get("app") or {}).get("ultimo", 0)
    tem_app = time.time() - app < 14 * 86400
    out = []
    for d in displays():
        alvo = mapa.get(d["nome"]) or ("hud" if d["principal"] else "nada")
        if alvo == "hud" and tem_app:
            alvo = "nada"
        out.append({**d, "tela": alvo})
    return out


def _url(alvo: str) -> str:
    base = f"http://localhost:{settings.port}"
    # ?inicio=1: na primeira vez, o HUD já liga a palavra de ativação "Jarvis"
    return base + "/?inicio=1" if alvo == "hud" else f"{base}/tela/{alvo}"


def close_all() -> None:
    """Fecha as janelas do Jarvis (só os perfis dele; o seu Chrome normal fica intacto)."""
    subprocess.run(["pkill", "-f", "--", f"user-data-dir={PROFILES}/"], capture_output=True)
    for _ in range(20):  # espera os processos saírem, senão o Chrome reaproveita a janela antiga
        if subprocess.run(["pgrep", "-f", "--", f"user-data-dir={PROFILES}/"], capture_output=True).returncode != 0:
            break
        time.sleep(0.25)


def open_all(tela_cheia: bool | None = None) -> list[dict[str, Any]]:
    cfg = store.get("monitores") or {}
    full = cfg.get("tela_cheia", True) if tela_cheia is None else tela_cheia
    if not Path(CHROME).exists():
        raise RuntimeError("Google Chrome não encontrado em /Applications.")
    close_all()
    time.sleep(0.8)
    opened = []
    plano = plan()
    # com um monitor só, tela cheia travaria o Mac inteiro no Jarvis: abre como janela normal
    if len(plano) < 2:
        full = False
    for d in plano:
        if d["tela"] == "nada":
            continue
        profile = PROFILES / f"chrome-{d['tela']}"
        profile.mkdir(parents=True, exist_ok=True)
        args = [
            f"--user-data-dir={profile}",
            f"--app={_url(d['tela'])}",
            f"--window-position={d['x']},{d['y']}",
            f"--window-size={d['w']},{d['h']}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-session-crashed-bubble",
            "--autoplay-policy=no-user-gesture-required",
        ]
        if d["tela"] == "hud":
            args.append("--use-fake-ui-for-media-stream")  # microfone e câmera sem pergunta, só neste perfil
            # gestos e voz seguem funcionando com o HUD atrás de outra janela (modo mouse, trabalhar junto)
            args += ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"]
        if full:
            args.append("--kiosk")
        subprocess.Popen(["open", "-na", CHROME, "--args", *args])
        opened.append({"monitor": d["nome"], "tela": d["tela"]})
        time.sleep(1.2)  # cada janela precisa nascer antes da próxima para cair no monitor certo
    log.info("telas abertas: %s", opened)
    return opened


def wait_server(timeout: int = 90) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            if httpx.get(f"http://localhost:{settings.port}/health", timeout=2).status_code == 200:
                return True
        except httpx.HTTPError:
            pass
        time.sleep(2)
    return False


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    if not wait_server():
        print("Servidor do Jarvis não respondeu.", file=sys.stderr)
        sys.exit(1)
    cfg = store.get("monitores") or {}
    if "--login" in sys.argv:
        if not cfg.get("abrir_no_login", True):
            sys.exit(0)
        # só no login de verdade: instalar ou recarregar o serviço no meio do dia não abre janelas
        import psutil

        login = min((p.create_time() for p in psutil.process_iter(["name"]) if p.info["name"] == "loginwindow"), default=0)
        if login and time.time() - login > 600:
            print("Login antigo; não abro as telas agora.")
            sys.exit(0)
    time.sleep(3)  # dá tempo de o Mac terminar de montar os monitores após o login
    open_all()
