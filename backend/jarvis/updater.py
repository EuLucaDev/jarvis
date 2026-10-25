"""Atualização do Jarvis a partir do repositório (o "servidor" das versões é o remoto git, ex.: GitHub).

- check(): busca o remoto e diz se há versão nova, com o que mudou (assuntos dos commits).
- apply(): baixa (só avanço rápido), instala dependências, recompila o HUD e reinicia o servidor.
  Mostra o progresso nas telas (evento "atualizacao") para o HUD tocar a animação.
Nunca atualiza com mudanças locais não salvas no repositório: avisa em vez de mexer.
"""

import asyncio
import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .config import ROOT
from .hub import hub

log = logging.getLogger("jarvis.updater")

VERSION_FILE = ROOT / "VERSION"
_PATH = os.pathsep.join([str(Path.home() / ".local" / "bin"), "/opt/homebrew/bin", "/usr/local/bin", os.environ.get("PATH", "/usr/bin:/bin")])
_busy = False


def _git(*args: str, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=timeout, env={**os.environ, "PATH": _PATH})


def version() -> dict[str, Any]:
    v = VERSION_FILE.read_text().strip() if VERSION_FILE.exists() else "0.0.0"
    sha = _git("rev-parse", "--short", "HEAD").stdout.strip()
    return {"versao": v, "commit": sha}


def _remote() -> str | None:
    r = _git("remote")
    return (r.stdout.split() or [None])[0]


def check() -> dict[str, Any]:
    atual = version()
    remoto = _remote()
    if not remoto:
        return {**atual, "disponivel": False, "motivo": "Sem servidor de atualização (o repositório não tem remoto)."}
    f = _git("fetch", "--quiet", remoto, timeout=40)
    if f.returncode != 0:
        return {**atual, "disponivel": False, "motivo": f"Não consegui falar com o servidor: {f.stderr.strip()[:160]}"}
    ramo = _git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip() or "main"
    alvo = f"{remoto}/{ramo}"
    atras = _git("rev-list", "--count", f"HEAD..{alvo}").stdout.strip()
    n = int(atras or 0)
    if not n:
        return {**atual, "disponivel": False}
    nova = _git("show", f"{alvo}:VERSION").stdout.strip() or atual["versao"]
    mudancas = [x for x in _git("log", "--format=%s", f"HEAD..{alvo}").stdout.splitlines() if x][:8]
    app = bool(_git("diff", "--name-only", f"HEAD..{alvo}", "--", "desktop-app").stdout.strip())
    return {**atual, "disponivel": True, "nova": nova, "commits": n, "mudancas": mudancas, "app_muda": app}


async def _step(etapa: str, pct: int) -> None:
    await hub.broadcast({"type": "atualizacao", "etapa": etapa, "pct": pct})


async def _run(cmd: list[str], cwd: Path, timeout: int = 600) -> tuple[bool, str]:
    p = await asyncio.create_subprocess_exec(*cmd, cwd=cwd, env={**os.environ, "PATH": _PATH}, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(p.communicate(), timeout)
    except TimeoutError:
        p.kill()
        return False, "passou do tempo"
    return p.returncode == 0, out.decode(errors="replace")[-600:]


async def apply() -> dict[str, Any]:
    global _busy
    if _busy:
        return {"erro": "Já estou atualizando."}
    sujo = [x for x in _git("status", "--porcelain").stdout.splitlines() if x.strip()]
    if sujo:
        return {"erro": "Há mudanças locais não salvas no repositório do Jarvis; salve (commit) antes de atualizar.", "arquivos": sujo[:10]}
    info = check()
    if not info.get("disponivel"):
        return {"erro": info.get("motivo") or "Já está na versão mais nova."}
    _busy = True
    try:
        await _step("Baixando a nova versão", 10)
        ok, out = await _run(["git", "pull", "--ff-only"], ROOT, 120)
        if not ok:
            raise RuntimeError(f"git pull: {out}")
        await _step("Atualizando o núcleo", 35)
        uv = shutil.which("uv", path=_PATH) or "uv"
        ok, out = await _run([uv, "sync"], ROOT / "backend", 300)
        if not ok:
            raise RuntimeError(f"uv sync: {out}")
        await _step("Recompilando a interface", 55)
        npm = shutil.which("npm", path=_PATH) or "npm"
        ok, out = await _run([npm, "install", "--no-audit", "--no-fund"], ROOT / "frontend", 600)
        if ok:
            ok, out = await _run([npm, "run", "build"], ROOT / "frontend", 600)
        if not ok:
            raise RuntimeError(f"build: {out}")
        await _step("Reiniciando sistemas", 85)
        await hub.broadcast({"type": "atualizacao", "etapa": "Reiniciando sistemas", "pct": 90, "reiniciar": True, "app_muda": info.get("app_muda")})
        _restart()
        return {"ok": True, "versao": info.get("nova")}
    except Exception as exc:  # noqa: BLE001
        log.warning("atualização falhou: %s", exc)
        await hub.broadcast({"type": "atualizacao", "etapa": "Falhou", "pct": 0, "erro": str(exc)[:300]})
        return {"erro": str(exc)[:300]}
    finally:
        _busy = False


def _restart() -> None:
    """Reinicia o servidor: pelo serviço do macOS, se for ele; senão sai e o app Jarvis sobe de novo."""
    if os.environ.get("JARVIS_APP_CHILD"):
        asyncio.get_running_loop().call_later(1.0, os._exit, 0)
        return
    subprocess.Popen(
        ["/bin/sh", "-c", f"sleep 1; launchctl kickstart -k gui/{os.getuid()}/com.jarvis.servidor"],
        start_new_session=True,
    )
