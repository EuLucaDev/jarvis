"""Protocolos: rotinas com nome ("modo foco", "encerrar o dia"), montadas no painel ou por voz.

Cada passo usa uma ação que o Jarvis já tem, da mesma lista fechada (sem comando livre). Uma rotina pode ter
horário ("quando": {"hora": "09:00", "dias": [0, 1, 2, 3, 4]}, 0 = segunda): o laço daqui roda na hora.
"""

import asyncio
import datetime as dt
import difflib
import logging
import re
import unicodedata
import uuid
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
    "aba": "Nova aba do navegador (endereço ou o que pesquisar)",
    "janela": "Janela de um app (app:ação, ex.: Spotify:minimizar, Chrome:esquerda)",
    "pasta": "Abrir pasta ou arquivo (ex.: Documentos/Contratos)",
    "espelho": "Espelho da tela (ligar ou desligar)",
    "camera": "Câmera (ligar ou desligar)",
    "esperar": "Esperar (segundos)",
}
DIAS = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"]


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
    if tipo == "aba":
        from . import web

        return await asyncio.to_thread(web.acao, "nova_aba", v)
    if tipo == "janela":
        from . import pc

        app, _, acao = v.rpartition(":")
        return await asyncio.to_thread(pc.janela_app, app.strip(), (acao or "focar").strip())
    if tipo == "pasta":
        return await asyncio.to_thread(system.open_item, v)
    if tipo == "espelho":
        from .screen import espelho

        await asyncio.to_thread(espelho.stop if v.lower().startswith("des") else espelho.start)
        return {"ok": True}
    if tipo == "camera":
        from .hands import hands

        liga = not v.lower().startswith("des")
        store.put("camera", {**store.get("camera"), "ligada": liga})
        await asyncio.to_thread(hands.start if liga else hands.stop)
        return {"ok": True}
    if tipo == "esperar":
        await asyncio.sleep(min(120.0, float(re.sub(r"[^\d.]", "", v) or 2)))
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


# ---------- criar por voz e rodar no horário ----------


def save(nome: str, passos: list[dict[str, str]], frases: list[str] | None = None, fala: str = "",
         hora: str | None = None, dias: list[int] | None = None) -> dict[str, Any]:
    """Cria ou substitui uma rotina (pelo nome). Passos fora da lista fechada são recusados."""
    nome = " ".join(nome.split())[:60]
    if not nome:
        return {"erro": "A rotina precisa de um nome."}
    limpos = []
    for p in passos or []:
        tipo = str(p.get("tipo", "")).strip()
        if tipo not in TIPOS:
            return {"erro": f"Passo '{tipo}' não existe.", "tipos": TIPOS}
        limpos.append({"tipo": tipo, "valor": str(p.get("valor", ""))[:300]})
    if not limpos:
        return {"erro": "A rotina precisa de pelo menos um passo."}
    quando = None
    if hora:
        m = re.match(r"^(\d{1,2})[:h]?(\d{2})?$", hora.strip().lower())
        if not m or int(m.group(1)) > 23:
            return {"erro": "Horário inválido; use HH:MM."}
        quando = {"hora": f"{int(m.group(1)):02d}:{m.group(2) or '00'}", "dias": sorted({int(d) for d in (dias if dias else range(7)) if 0 <= int(d) <= 6})}
    lista = [p for p in store.get("protocolos") or [] if _norm(p["nome"]) != _norm(nome)]
    novo = {"id": uuid.uuid4().hex[:8], "nome": nome, "frases": [f for f in (frases or []) if f][:6], "fala": fala[:300], "passos": limpos}
    if quando:
        novo["quando"] = quando
    store.put("protocolos", [*lista, novo])
    return {"ok": True, "rotina": novo}


def remove(nome: str) -> dict[str, Any]:
    p = find(nome)
    if not p:
        return {"erro": f"Não há rotina chamada {nome}."}
    store.put("protocolos", [x for x in store.get("protocolos") or [] if x.get("id") != p.get("id") or x["nome"] != p["nome"]])
    return {"ok": True, "apagada": p["nome"]}


def describe() -> list[dict[str, Any]]:
    out = []
    for p in store.get("protocolos") or []:
        q = p.get("quando")
        quando = f"{q['hora']} ({', '.join(DIAS[d] for d in q.get('dias', []))})" if q else "só quando pedir"
        out.append({"nome": p["nome"], "quando": quando, "passos": [f"{x['tipo']} {x.get('valor', '')}".strip() for x in p.get("passos", [])]})
    return out


async def loop() -> None:
    """Roda as rotinas com horário (confere a cada 20 s; cada uma no máximo uma vez por dia)."""
    from .live import voice

    while True:
        await asyncio.sleep(20)
        try:
            agora = dt.datetime.now()
            hhmm, hoje = agora.strftime("%H:%M"), agora.strftime("%Y-%m-%d")
            feitas = store.get("protocolos_rodados") or {}
            for p in store.get("protocolos") or []:
                q = p.get("quando")
                if not q or q.get("hora") != hhmm or agora.weekday() not in q.get("dias", range(7)):
                    continue
                chave = p.get("id") or p["nome"]
                if feitas.get(chave) == hoje:
                    continue
                feitas[chave] = hoje
                store.put("protocolos_rodados", feitas)
                log.info("rotina %s no horário", p["nome"])
                res = await run(p["nome"])
                await hub.broadcast({"type": "alerta", "id": f"rot-{chave}", "titulo": f"Rotina · {p['nome']}",
                                     "texto": f"{len(res.get('feitos', []))} passos feitos" + (f", {len(res['falhas'])} com falha" if res.get("falhas") else ""),
                                     "nivel": "normal"})
                if p.get("fala"):
                    await voice.ask(f"[Aviso do sistema, não é o usuário falando.] A rotina {p['nome']} acabou de rodar no horário. Diga em voz: {p['fala']}")
        except Exception as exc:  # noqa: BLE001
            log.warning("laço das rotinas: %s", exc)
