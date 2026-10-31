"""O Jarvis de bolso: a cópia que este computador deixa na conta, para o Telegram responder com ele desligado.

Como o GitHub, mas com uma casa só: os dados de verdade (financeiro, memória) ficam aqui. A cada poucos minutos,
se algo mudou, `loop()` manda à portaria uma cópia enxuta (os meses recentes do financeiro, contas, cartões, o que
vence, metas, investimentos, a memória e as últimas conversas do Telegram) e a chave da Gemini da pessoa. Com o
computador desligado, o Jarvis de bolso (bolso.py, na portaria) responde com essa cópia; o que a pessoa lança pelo
celular vira pendência, e quando este computador conecta, `aplicar()` roda cada uma pelas mesmas ferramentas de
sempre e manda a cópia nova.

Ajuste "bolso" (padrão ligado): desligado, a cópia e a chave são apagadas da conta.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import json
import logging
import time
from typing import Any

import httpx

from . import store

log = logging.getLogger("jarvis.copia")

INTERVALO = 120  # confere a cada 2 min; só envia se mudou (ou a cada 30 min, para a data da cópia andar)
estado: dict[str, Any] = {"enviada": None, "erro": None, "tamanho": 0}
_agora = asyncio.Event()  # pede uma cópia nova já (ex.: depois de aplicar as pendências)


def ligado() -> bool:
    return bool((store.get("bolso") or {}).get("ativo", True))


async def _financeiro() -> dict[str, Any] | None:
    from . import finance, textos
    from .config import settings

    if not getattr(settings, "financeiro", True):
        return None
    chamar = finance.chamar
    hoje = dt.date.today()
    mes = hoje.strftime("%Y-%m")
    meses = [mes, textos.mes_anterior(mes), textos.mes_anterior(textos.mes_anterior(mes))]
    out: dict[str, Any] = {"meses": {}}
    for m in meses:
        out["meses"][m] = await textos.dados_mes(chamar, m)
    contas = await chamar("accounts:list") or []
    out["contas"] = [{"nome": c.get("name"), "banco": c.get("bankName"), "saldo": c.get("currentBalance")}
                     for c in contas if c.get("status", "ATIVA") in ("ATIVA", "ATIVO")]
    cartoes = await chamar("cards:list") or []
    out["cartoes"] = [{"nome": c.get("name"), "tipo": c.get("cardType"), "limite": c.get("limit") or c.get("creditLimit")}
                      for c in cartoes if c.get("status", "ATIVO") in ("ATIVA", "ATIVO")]
    pagar = await chamar("payables:list", 30) or []
    out["a_pagar"] = [{"titulo": i.get("title"), "valor": i.get("amount"), "categoria": i.get("category"), "tipo": i.get("kind"),
                       "vence": (hoje + dt.timedelta(days=int(i.get("days") or 0))).isoformat()} for i in pagar]
    try:
        out["orcamento"] = [{"categoria": r.get("category"), "usado": r.get("used"), "limite": r.get("limit"), "pct": r.get("pct"),
                             "vai_estourar": r.get("willExceed")} for r in await chamar("insights:budgetPace", mes) or []]
    except finance.FinErro:
        out["orcamento"] = []
    out["metas"] = [{"nome": g.get("name"), "alvo": g.get("targetAmount"), "guardado": g.get("savedAmount"), "prazo": g.get("targetDate"),
                     "status": g.get("status")} for g in await chamar("goals:list") or []]
    try:
        port = await chamar("investments:portfolio") or {}
        ativos = await chamar("investments:list") or []
        out["investimentos"] = {"total": port.get("marketValue") or port.get("total"),
                                "ativos": [{"nome": i.get("name") or i.get("symbol"), "valor": i.get("marketValue") or i.get("currentAmount"),
                                            "instituicao": i.get("institution")} for i in ativos if i.get("status") == "ATIVO"]}
    except finance.FinErro:
        out["investimentos"] = None
    try:
        cats = await chamar("categories:list") or {}
        out["categorias"] = cats if isinstance(cats, dict) else {"todas": cats}
    except finance.FinErro:
        out["categorias"] = {}
    return out


def _memorias() -> list[dict[str, Any]]:
    import sqlite3

    from .memory import DB_PATH

    if not DB_PATH.exists():
        return []
    con = sqlite3.connect(DB_PATH)
    try:
        linhas = con.execute("select tipo, texto from memorias where ativa = 1 order by usos desc, atualizada desc limit 400").fetchall()
    except sqlite3.Error:
        return []
    finally:
        con.close()
    return [{"tipo": t, "texto": x} for t, x in linhas]


async def montar() -> dict[str, Any]:
    from .config import settings

    tg = store.get("telegram") or {}
    chat = tg.get("chat")
    conversas = {}
    if chat:
        conversas[str(chat)] = (store.get(f"conversa:{chat}") or {}).get("linhas", [])
    try:
        fin = await _financeiro()
    except Exception as exc:  # noqa: BLE001 - sem o financeiro, a cópia vai com o resto
        log.warning("cópia do financeiro: %s", exc)
        fin = None
    return {"versao": 1, "gerado": time.time(), "fuso": settings.fuso, "nome": settings.user_name, "chamar": settings.chamar,
            "cidade": settings.city, "modelo": settings.text_model, "chat": chat, "financeiro": fin, "memorias": _memorias(),
            "conversas": conversas}


async def enviar(forcar: bool = False) -> None:
    from . import nuvem
    from .config import settings

    if not ligado():
        if estado.get("enviada") is not False:
            async with httpx.AsyncClient(timeout=30) as c:
                await c.post(nuvem.url("/api/ponte/copia"), json={"desligar": True}, headers=nuvem.cabecalho())
            estado.update(enviada=False, erro=None)
        return
    copia = await montar()
    corpo = json.dumps({k: v for k, v in copia.items() if k != "gerado"}, sort_keys=True, ensure_ascii=False, default=str)
    marca = hashlib.sha256((corpo + settings.gemini_api_key).encode()).hexdigest()
    ultimo = store.get("bolso_envio") or {}
    if not forcar and ultimo.get("marca") == marca and time.time() - ultimo.get("em", 0) < 1800:
        return
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(nuvem.url("/api/ponte/copia"), json={"copia": copia, "chave": settings.gemini_api_key}, headers=nuvem.cabecalho())
    r.raise_for_status()
    store.put("bolso_envio", {"marca": marca, "em": time.time()})
    estado.update(enviada=time.time(), erro=None, tamanho=len(corpo))
    log.info("cópia do Jarvis de bolso enviada (%d KB)", len(corpo) // 1024)


async def loop() -> None:
    from . import nuvem

    await asyncio.sleep(20)
    while True:
        try:
            if nuvem.ligado():
                await enviar(forcar=_agora.is_set())
        except Exception as exc:  # noqa: BLE001 - sem internet ou portaria fora: tenta na próxima
            estado["erro"] = str(exc)[:160]
            log.warning("cópia: %s", exc)
        _agora.clear()
        try:
            await asyncio.wait_for(_agora.wait(), INTERVALO)
        except asyncio.TimeoutError:
            pass


def pedir_copia() -> None:
    _agora.set()


# ---------------------------------------------------------------- pendências feitas pelo celular


async def aplicar(itens: list[dict[str, Any]], conversas: dict[str, list[dict[str, Any]]] | None = None) -> list[str]:
    """Roda aqui o que foi feito no Jarvis de bolso (na ordem) e avisa no Telegram. Devolve os ids aplicados."""
    from . import finance_voz, telegram, textos, tools
    from .hub import coletor

    feitos = store.get("bolso_aplicadas") or {}
    ids, linhas_ok, linhas_erro = [], [], []
    for chave, linhas in (conversas or {}).items():  # o que foi conversado pelo celular continua na conversa daqui
        atual = (store.get(f"conversa:{chave}") or {}).get("linhas", [])
        novas = [{"papel": x["papel"], "texto": x["texto"]} for x in linhas]
        store.put(f"conversa:{chave}", {"linhas": (atual + novas)[-16:], "em": time.time()})
    chat = None
    for p in itens:
        pid = p.get("id")
        chat = p.get("chat") or chat
        if not pid:
            continue
        if pid in feitos:
            ids.append(pid)
            continue
        if p.get("ferramenta") == "desfazer_bolso":  # Desfazer tocado no celular depois que já tinha entrado aqui
            await telegram.enviar(p["chat"], await desfazer(p["args"]["pid"]))
            feitos[pid] = {"em": time.time()}
            ids.append(pid)
            continue
        if p.get("ferramenta") == "pedido":  # algo que só o computador faz: ele responde agora
            await telegram._conversar(p["chat"], [telegram.types.Part(text=p["args"]["texto"])], p["args"]["texto"])  # noqa: SLF001
            feitos[pid] = {"em": time.time()}
            ids.append(pid)
            continue
        cartoes: list[dict[str, Any]] = []
        token = coletor.set(cartoes)
        try:
            res = await tools.run(p["ferramenta"], dict(p.get("args") or {}))
        except Exception as exc:  # noqa: BLE001
            res = {"erro": str(exc)[:200]}
        finally:
            coletor.reset(token)
        if isinstance(res, dict) and res.get("erro"):
            linhas_erro.append(f"⚠️ {textos.e(p.get('resumo') or p['ferramenta'])}: {textos.e(res['erro'])}")
            feitos[pid] = {"em": time.time(), "erro": True}
        else:
            linhas_ok.append(f"{textos.e(p.get('resumo') or p['ferramenta'])}")
            u = finance_voz._ultimos[-1] if p["ferramenta"] in ("financeiro_lancar", "financeiro_transferir", "financeiro_meta") and finance_voz._ultimos else None  # noqa: SLF001
            feitos[pid] = {"em": time.time(), "tipo": u and u["tipo"], "ref": u and u["id"]}
        ids.append(pid)
    if len(feitos) > 500:
        feitos = dict(sorted(feitos.items(), key=lambda kv: kv[1]["em"])[-500:])
    store.put("bolso_aplicadas", feitos)
    if (linhas_ok or linhas_erro) and chat:
        texto = textos.titulo("🔄", "Sincronizado") + "\n" + "O que você fez pelo celular entrou no seu financeiro." + "\n" + textos.SEP
        texto += "\n" + "\n".join([f"✅ {x}" for x in linhas_ok] + linhas_erro)
        try:
            await telegram.enviar(chat, texto, pronto=True)
        except Exception as exc:  # noqa: BLE001
            log.warning("aviso de sincronização: %s", exc)
    pedir_copia()
    return ids


async def desfazer(pid: str) -> str:
    """Desfazer de um lançamento feito pelo celular que já entrou no financeiro daqui."""
    from . import finance_voz

    f = (store.get("bolso_aplicadas") or {}).get(pid)
    if not f or not f.get("ref"):
        return "Esse lançamento não está mais disponível para desfazer. Peça para eu apagar pelo nome."
    res = await finance_voz.desfazer(f["tipo"], f["ref"])
    pedir_copia()
    return "Desfeito." if res.get("ok") else res.get("erro", "Não consegui desfazer.")
