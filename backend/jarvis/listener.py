"""Liga o ouvido em segundo plano (listener_app.py) e transforma "Jarvis" ou duas palmas em "despertar":
o HUD aparece, a voz liga e ele cumprimenta (de manhã, com o bom dia) ou já faz o que foi pedido.

Só roda dentro do app Jarvis instalado, que tem as permissões de microfone e de reconhecimento de fala.
Enquanto a conversa está no ar, o ouvido pausa (quem ouve é a sessão de voz).
"""

import asyncio
import logging
import os
import sys
import time
from pathlib import Path

from . import store
from .hub import hub

log = logging.getLogger("jarvis.listener")

estado = {"ativo": False, "erro": None}


async def loop() -> None:
    if not os.environ.get("JARVIS_APP_CHILD"):
        return  # no navegador quem escuta "Jarvis" é o próprio Chrome (lib/wake.ts)
    falhas = 0
    while True:
        cfg = store.get("despertar")
        if not (cfg.get("palavra") or cfg.get("palmas")):
            estado["ativo"] = False
            await asyncio.sleep(10)
            continue
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "jarvis.listener_app", cwd=Path(__file__).resolve().parents[1],
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        vigia = asyncio.create_task(_pausa(proc))
        try:
            async for raw in proc.stdout:
                linha = raw.decode(errors="replace").strip()
                if linha == "pronto":
                    estado.update(ativo=True, erro=None)
                    falhas = 0
                    log.info("ouvido em segundo plano no ar")
                elif linha.startswith("erro|"):
                    estado.update(ativo=False, erro=linha[5:])
                    log.warning("ouvido: %s", linha[5:])
                elif linha.startswith("wake|") and cfg.get("palavra", True):
                    await despertar("voz", linha[5:])
                elif linha == "palmas" and cfg.get("palmas", True):
                    await despertar("palmas", "")
        finally:
            vigia.cancel()
            if proc.returncode is None:
                proc.kill()
        estado["ativo"] = False
        falhas += 1
        await asyncio.sleep(min(60, 3 * falhas))


async def _pausa(proc) -> None:
    """Com a conversa no ar, o ouvido para de disparar (e volta quando a voz desliga)."""
    ultimo = None
    while proc.returncode is None:
        no_ar = hub.status.get("voice") in ("live", "connecting")
        if no_ar != ultimo and proc.stdin:
            proc.stdin.write(b"pausa\n" if no_ar else b"volta\n")
            await proc.stdin.drain()
            ultimo = no_ar
        await asyncio.sleep(0.5)


async def despertar(origem: str, comando: str) -> None:
    if hub.status.get("voice") == "live":
        return
    p = store.get("presenca")
    hoje = time.strftime("%Y-%m-%d")
    manha = 5 <= int(time.strftime("%H")) < 12
    bom_dia = not comando and manha and p.get("ultimo_briefing") != hoje and store.get("despertar").get("bom_dia", True)
    if bom_dia:
        store.put("presenca", {**p, "ultimo_briefing": hoje})
    log.info("despertar por %s: %s", origem, comando or ("bom dia" if bom_dia else "saudação"))
    await hub.broadcast({"type": "despertar", "origem": origem, "comando": comando, "bom_dia": bom_dia})
