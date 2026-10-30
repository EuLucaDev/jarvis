"""Financeiro do Jarvis: liga o motor financeiro (Node, as regras da Carteira Pessoal) e conversa com ele.

- O motor é um processo filho (`financeiro/servidor.js`) que só ouve em 127.0.0.1, com token por sessão.
  Se cair, sobe de novo. Os dados ficam em `<pasta do Jarvis>/financeiro/` (banco, backups, anexos).
- `chamar(operação, *args)` é usado pelas ferramentas de voz, pelos avisos e pela rota `/api/fin/c/...`
  que as telas do financeiro (frontend/public/financeiro, via ponte.js) usam.
- Diálogos de arquivo das telas são os do sistema (Mac: osascript; Windows: PowerShell; Linux: zenity).
"""

import asyncio
import json
import logging
import os
import secrets
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx

from .config import CODE_ROOT, FROZEN, HOME, settings

log = logging.getLogger("jarvis.finance")

DADOS = HOME / "financeiro"
ENTRADA = DADOS / "entrada"  # arquivos arrastados para a tela (extratos, comprovantes)
MOTOR = CODE_ROOT / ("financeiro" if FROZEN else "financeiro/motor")


class FinErro(Exception):
    pass


def _node() -> str | None:
    if FROZEN:
        p = CODE_ROOT / "node" / ("node.exe" if sys.platform == "win32" else "node")
        return str(p) if p.exists() else None
    return shutil.which("node")


def _porta_livre() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Motor:
    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.porta = 0
        self.token = secrets.token_hex(16)
        self.erro: str | None = None
        self._cliente: httpx.AsyncClient | None = None
        self.loop: asyncio.AbstractEventLoop | None = None

    @property
    def ligado(self) -> bool:
        return bool(self.proc and self.proc.poll() is None)

    def disponivel(self, local: bool = False) -> bool:
        """O motor deste computador pode subir? Com a nuvem ligada, o financeiro é o de lá (local=True ignora isso)."""
        if not local:
            from . import nuvem

            if nuvem.ligado():
                return False
        return settings.public().get("financeiro", True) is not False and (MOTOR / "servidor.js").exists() and bool(_node())

    def start(self) -> None:
        if self.ligado:
            return
        node = _node()
        if not node or not (MOTOR / "servidor.js").exists():
            self.erro = "O motor financeiro não veio neste pacote."
            log.warning(self.erro)
            return
        DADOS.mkdir(parents=True, exist_ok=True)
        self.porta = _porta_livre()
        env = {**os.environ, "FIN_DADOS": str(DADOS), "FIN_TOKEN": self.token, "FIN_PORTA": str(self.porta)}
        tess = MOTOR / "tessdata"
        if tess.exists():
            env["FIN_TESSDATA"] = str(tess)
            env["FIN_OCR_CACHE"] = str(DADOS / "ocr")
            (DADOS / "ocr").mkdir(exist_ok=True)
        log_f = open(HOME / "financeiro.log", "a", encoding="utf-8")  # noqa: SIM115 - fica aberto com o processo
        flags = 0x08000000 if sys.platform == "win32" else 0  # sem janela de console no Windows
        # entrada padrão aberta: quando o núcleo sai, ela fecha e o motor sai junto
        self.proc = subprocess.Popen([node, "servidor.js"], cwd=MOTOR, env=env, stdin=subprocess.PIPE, stdout=log_f,
                                     stderr=subprocess.STDOUT, creationflags=flags)
        self._cliente = None
        for _ in range(100):
            try:
                with socket.create_connection(("127.0.0.1", self.porta), timeout=0.2):
                    self.erro = None
                    log.info("motor financeiro no ar (porta %s)", self.porta)
                    return
            except OSError:
                if self.proc.poll() is not None:
                    break
                time.sleep(0.1)
        self.erro = "O motor financeiro não abriu (veja financeiro.log)."
        log.warning(self.erro)

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.stdin.close()  # type: ignore[union-attr]
                self.proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                self.proc.kill()

    async def vigiar(self) -> None:
        """Sobe de novo se o motor cair."""
        while True:
            await asyncio.sleep(5)
            if self.disponivel() and not self.ligado:
                log.warning("motor financeiro caiu; subindo de novo")
                await asyncio.to_thread(self.start)

    async def chamar(self, canal: str, *args: Any) -> Any:
        if not self.ligado:
            await asyncio.to_thread(self.start)
            if not self.ligado:
                raise FinErro(self.erro or "Financeiro indisponível.")
        if self._cliente is None:
            self._cliente = httpx.AsyncClient(base_url=f"http://127.0.0.1:{self.porta}", timeout=120,
                                              headers={"x-token": self.token})
        r = await self._cliente.post(f"/c/{canal}", content=json.dumps({"args": list(args)}, ensure_ascii=False))
        corpo = r.json()
        if not corpo.get("ok"):
            raise FinErro(corpo.get("error") or "Erro no financeiro.")
        return corpo.get("data")


motor = Motor()


async def chamar(canal: str, *args: Any) -> Any:
    from . import nuvem

    if nuvem.ligado():  # o financeiro mora na nuvem: a operação vai para lá
        return await nuvem.fin(canal, *args)
    return await motor.chamar(canal, *args)


async def mudou() -> None:
    """Avisa as telas abertas do financeiro e o HUD que algo foi lançado (recarregam)."""
    from .hub import hub

    await hub.broadcast({"type": "financeiro.mudou"})


# ---------- diálogos de arquivo do sistema (para as telas do financeiro) ----------


def _osa(script: str) -> str | None:
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=600)
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def _ps(script: str) -> str | None:
    r = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", script], capture_output=True, text=True,
                       timeout=600, creationflags=0x08000000)
    return r.stdout.strip() or None


def _zenity(args: list[str]) -> str | None:
    prog = shutil.which("zenity")
    if not prog:
        return None
    r = subprocess.run([prog, *args], capture_output=True, text=True, timeout=600)
    return r.stdout.strip() if r.returncode == 0 else None


def escolher_arquivos(multiplo: bool, extensoes: list[str] | None = None) -> list[str]:
    exts = [e.lstrip(".").lower() for e in (extensoes or []) if e and e != "*"]
    if sys.platform == "darwin":
        tipos = f" of type {{{', '.join(json.dumps(e) for e in exts)}}}" if exts else ""
        multi = " with multiple selections allowed" if multiplo else ""
        out = _osa(f'set r to choose file with prompt "Escolha o arquivo"{tipos}{multi}\n'
                   'set s to ""\nrepeat with f in (r as list)\nset s to s & POSIX path of f & linefeed\nend repeat\nreturn s')
        return [ln for ln in (out or "").splitlines() if ln]
    if sys.platform == "win32":
        filtro = ";".join(f"*.{e}" for e in exts) or "*.*"
        out = _ps("Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; "
                  f"$d.Filter = 'Arquivos|{filtro}'; $d.Multiselect = ${str(multiplo).lower()}; "
                  "if ($d.ShowDialog() -eq 'OK') { $d.FileNames -join \"`n\" }")
        return [ln.strip() for ln in (out or "").splitlines() if ln.strip()]
    args = ["--file-selection", "--title=Escolha o arquivo", "--separator=\n"]
    if multiplo:
        args.append("--multiple")
    if exts:
        args.append("--file-filter=" + " ".join(f"*.{e}" for e in exts))
    return [ln for ln in (_zenity(args) or "").splitlines() if ln]


def escolher_destino(nome: str) -> str | None:
    if sys.platform == "darwin":
        return _osa(f'POSIX path of (choose file name with prompt "Salvar como" default name {json.dumps(nome)})')
    if sys.platform == "win32":
        return _ps("Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.SaveFileDialog; "
                   f"$d.FileName = '{nome.replace(chr(39), '')}'; if ($d.ShowDialog() -eq 'OK') {{ $d.FileName }}")
    return _zenity(["--file-selection", "--save", "--confirm-overwrite", f"--filename={nome}"])


def escolher_pasta() -> str | None:
    if sys.platform == "darwin":
        return _osa('POSIX path of (choose folder with prompt "Escolha a pasta")')
    if sys.platform == "win32":
        return _ps("Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; "
                   "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }")
    return _zenity(["--file-selection", "--directory"])


def _extensoes(options: dict | None) -> list[str]:
    out: list[str] = []
    for f in (options or {}).get("filters") or []:
        out += f.get("extensions") or []
    return out


async def dialogo(canal: str, options: dict | None) -> Any:
    """Os canais dialog:* e shell:* que no app original eram do Electron."""
    from . import pc

    options = options or {}
    if canal == "dialog:openFiles":
        return await asyncio.to_thread(escolher_arquivos, True, _extensoes(options))
    if canal == "dialog:openFile":
        r = await asyncio.to_thread(escolher_arquivos, False, _extensoes(options))
        if not r:
            return None
        p = Path(r[0])
        out: dict[str, Any] = {"path": str(p), "name": p.name}
        if options.get("readContent", True) and p.stat().st_size < 50_000_000:
            out["content"] = p.read_text(encoding="utf-8", errors="ignore")
        return out
    if canal == "dialog:openFolder":
        return await asyncio.to_thread(escolher_pasta)
    if canal == "dialog:saveFile":
        destino = await asyncio.to_thread(escolher_destino, options.get("defaultName") or "arquivo.txt")
        if not destino:
            return None
        Path(destino).write_text(options.get("content") or "", encoding="utf-8")
        return destino
    if canal == "shell:openPath":
        await asyncio.to_thread(pc.open_path, str(options))
        return True
    if canal == "shell:openExternal":
        if str(options).startswith(("http://", "https://")):
            await asyncio.to_thread(pc.open_link, str(options))
        return True
    raise FinErro(f"Operação desconhecida: {canal}")


def guardar_entrada(nome: str, dados: bytes) -> str:
    """Arquivo arrastado para a tela: guarda em financeiro/entrada e devolve o caminho."""
    ENTRADA.mkdir(parents=True, exist_ok=True)
    seguro = "".join(c for c in Path(nome).name if c.isalnum() or c in " ._-()") or "arquivo"
    alvo = ENTRADA / f"{int(time.time())}-{seguro}"
    alvo.write_bytes(dados)
    return str(alvo)
