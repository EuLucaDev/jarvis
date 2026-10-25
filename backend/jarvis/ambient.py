"""Luz ambiente que acompanha o Jarvis (em espera, ouvindo, pensando, falando), pela Alexa/Voice Monkey.

Cada fase aponta para um dispositivo (rotina) do Voice Monkey cadastrado em Conexões → Alexa. Desligado por
padrão; troca no máximo a cada 1,5 s para não metralhar a Alexa.
"""

import asyncio
import time

from . import store

_ultima = ("", 0.0)


async def apply(fase: str) -> None:
    global _ultima
    cfg = store.get("ambiente")
    alvo = (cfg.get(fase) or "").strip()
    if not cfg.get("ativo") or not alvo:
        return
    if _ultima[0] == alvo or time.time() - _ultima[1] < 1.5:
        return
    _ultima = (alvo, time.time())
    from . import system

    await asyncio.to_thread(system.alexa, alvo, "ligar")
