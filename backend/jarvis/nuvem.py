"""Ligação do Jarvis deste computador com a conta (jarvis.agcunae.com).

O Jarvis roda aqui: financeiro, memória e conversas ficam neste computador. A VPS só faz a ponte do Telegram.
- A conta vem do launcher (nuvem-launcher.json, com o acesso deste computador) ou, à mão, do painel.
- `loop()` mantém a ponte aberta (WebSocket /api/ponte): as mensagens do Telegram daquela conta chegam aqui e o
  Jarvis responde pelo robô (telegram.py). Sem internet ou com a VPS fora, tenta de novo com espera crescente; o que
  chegar enquanto isso fica na fila da VPS e é entregue quando reconectar.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any

from . import store

log = logging.getLogger("jarvis.nuvem")

estado: dict[str, Any] = {"conectado": False, "erro": None}


def cfg() -> dict[str, Any]:
    return _do_launcher(store.get("nuvem") or {})


def _do_launcher(c: dict[str, Any]) -> dict[str, Any]:
    """O launcher deixa o acesso da conta em nuvem-launcher.json: o Jarvis já nasce ligado (e segue a conta se trocar)."""
    from .config import HOME

    f = HOME / "nuvem-launcher.json"
    try:
        dados = json.loads(f.read_text()) if f.exists() else None
    except (OSError, ValueError):
        dados = None
    if not dados or not dados.get("token"):
        return c
    if c.get("token") == dados["token"] and c.get("ativo", True):
        return c
    novo = {"url": dados["url"], "token": dados["token"], "perfil": dados["perfil"], "ativo": True, "pelo_launcher": True,
            "nome": dados.get("nome"), "email": dados.get("email")}
    store.put("nuvem", novo)
    log.info("ligado à conta do launcher (%s)", dados.get("email", ""))
    return novo


def ligado() -> bool:
    c = cfg()
    return bool(c.get("url") and c.get("token") and c.get("ativo", True))


def url(caminho: str) -> str:
    return f"{cfg()['url'].rstrip('/')}{caminho}"


def cabecalho() -> dict[str, str]:
    return {"authorization": f"Bearer {cfg()['token']}"}


async def _tratar(msg: dict[str, Any]) -> None:
    if msg.get("tipo") == "telegram":
        from . import telegram

        try:
            await telegram.tratar(msg["update"])
        except Exception:  # noqa: BLE001
            log.exception("mensagem do Telegram")


async def loop() -> None:
    """Mantém a ponte aberta enquanto o Jarvis estiver ligado a uma conta."""
    import websockets

    espera = 2
    while True:
        if not ligado():
            estado.update(conectado=False, erro=None)
            await asyncio.sleep(15)
            continue
        alvo = url("/api/ponte").replace("https://", "wss://").replace("http://", "ws://")
        try:
            async with websockets.connect(alvo, additional_headers=cabecalho(), ping_interval=25, ping_timeout=20,
                                          open_timeout=20, max_size=8 * 1024 * 1024) as ws:
                estado.update(conectado=True, erro=None)
                espera = 2
                log.info("ponte do Telegram aberta")
                async for bruto in ws:
                    try:
                        asyncio.create_task(_tratar(json.loads(bruto)))
                    except ValueError:
                        continue
        except Exception as exc:  # noqa: BLE001 - sem internet, VPS fora, conta pausada: tenta de novo depois
            recusado = getattr(getattr(exc, "rcvd", None), "code", None) == 4401 or \
                getattr(getattr(exc, "response", None), "status_code", None) in (401, 403)
            estado.update(conectado=False, erro="Conta pausada ou acesso trocado." if recusado else str(exc)[:160])
            if recusado:
                espera = 300
        estado["conectado"] = False
        await asyncio.sleep(espera + random.random() * 2)
        espera = min(espera * 2, 120)
