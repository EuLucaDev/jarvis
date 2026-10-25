"""Protocolos: rotinas com nome ("modo foco", "encerrar o dia") montadas no painel.

Cada passo usa uma ação que o Jarvis já tem, da mesma lista fechada (sem comando livre):
app, link, atalho, volume, brilho, midia, casa, painel, telas, limpar.
"""

import asyncio
import difflib
import logging
import unicodedata
from typing import Any

from . import store, system
from .hub import hub

log = logging.getLogger("jarvis.protocols")

TIPOS = {
    "app": "Abrir app (nome)",
    "link": "Abrir site (endereço)",
    "atalho": "Rodar Atalho do macOS (nome)",
    "volume": "Volume (0 a 100)",
    "brilho": "Brilho (5 a 100)",
    "midia": "Música (tocar_pausar, proxima, anterior)",
    "casa": "Alexa (dispositivo:ligar ou dispositivo:desligar)",
    "painel": "Painel do HUD (agenda, comunicacoes, radar, nucleo, cameras, fechar)",
    "limpar": "Limpar cartões",
}


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return " ".join(w for w in s.split() if w not in {"protocolo", "modo", "rotina", "o", "a", "de", "do", "da"})


def find(nome: str) -> dict[str, Any] | None:
    lista = store.get("protocolos") or []
    alvo = _norm(nome)
    nomes = {_norm(p["nome"]): p for p in lista}
    for p in lista:
        for frase in [p["nome"], *p.get("frases", [])]:
            if _norm(frase) == alvo:
                return p
    hit = difflib.get_close_matches(alvo, list(nomes), n=1, cutoff=0.6)
    return nomes[hit[0]] if hit else None


async def _step(tipo: str, valor: str) -> dict[str, Any]:
    v = (valor or "").strip()
    if tipo == "app":
        return await asyncio.to_thread(system.open_app, v)
    if tipo == "link":
        return await asyncio.to_thread(system.open_link, v)
    if tipo == "atalho":
        return await asyncio.to_thread(system.run_shortcut, v, None)
    if tipo == "volume":
        return await asyncio.to_thread(system.volume, int(float(v or 50)))
    if tipo == "brilho":
        return await asyncio.to_thread(system.brightness, int(float(v or 70)))
    if tipo == "midia":
        return await asyncio.to_thread(system.media, v or "tocar_pausar")
    if tipo == "casa":
        disp, _, acao = v.partition(":")
        return await asyncio.to_thread(system.alexa, disp.strip(), (acao or "ligar").strip())
    if tipo == "painel":
        await hub.broadcast({"type": "painel", "visao": None if v in ("", "fechar") else v})
        return {"ok": True}
    if tipo == "limpar":
        await hub.clear_cards()
        return {"ok": True}
    return {"erro": f"Passo desconhecido: {tipo}"}


async def run(nome: str) -> dict[str, Any]:
    p = find(nome)
    if not p:
        disponiveis = [x["nome"] for x in store.get("protocolos") or []]
        return {"erro": f"Não há protocolo chamado {nome}.", "protocolos": disponiveis}
    feitos, falhas = [], []
    for passo in p.get("passos", []):
        try:
            r = await _step(passo.get("tipo", ""), str(passo.get("valor", "")))
        except Exception as exc:  # noqa: BLE001
            r = {"erro": str(exc)}
        rotulo = f"{passo.get('tipo')} {passo.get('valor', '')}".strip()
        if isinstance(r, dict) and r.get("erro"):
            falhas.append(f"{rotulo} ({r['erro']})")
        else:
            feitos.append(rotulo)
    log.info("protocolo %s: %d passos, %d falhas", p["nome"], len(feitos), len(falhas))
    return {
        "protocolo": p["nome"],
        "feitos": feitos,
        "falhas": falhas,
        "fala": p.get("fala", ""),
        "instrucao": "Confirme numa frase. Se houver 'fala', use-a. Conte só as falhas, se houver.",
    }
