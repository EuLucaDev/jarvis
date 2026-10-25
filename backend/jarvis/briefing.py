"""Briefing de "bom dia": junta clima, e-mails, agenda e notícias e escreve um roteiro falado.

O roteiro vem em segmentos; cada segmento diz qual cartão aparece enquanto o Jarvis fala aquele trecho.
"""

import asyncio
import datetime as dt
import logging
import time
from zoneinfo import ZoneInfo

from . import llm, store
from .config import settings
from .sources import agenda as agenda_src
from .sources import gmail as gmail_src
from .sources import news as news_src

log = logging.getLogger("jarvis.briefing")

WPS = 2.6  # palavras por segundo na fala da Gemini, para sincronizar os cartões


async def _weather(cfg: dict) -> dict | None:
    if not cfg.get("clima", True):
        return None
    from .tools import fetch_weather

    return await fetch_weather(cfg.get("cidade") or settings.city)


async def _emails(cfg: dict) -> dict:
    total, items = 0, []
    for acc in cfg.get("gmail", []):
        if acc.get("email") and acc.get("senha_app"):
            res = await asyncio.to_thread(gmail_src.fetch, acc)
            total += res["total"]
            items += res["emails"]
    if not items:
        return {"total": total, "atencao": [], "outros": 0}
    schema = {
        "type": "ARRAY",
        "items": {
            "type": "OBJECT",
            "properties": {
                "indice": {"type": "INTEGER"},
                "prioridade": {"type": "STRING", "enum": ["alta", "media", "baixa"]},
                "motivo": {"type": "STRING"},
                "acao": {"type": "STRING"},
            },
            "required": ["indice", "prioridade", "motivo"],
        },
    }
    lista = "\n".join(f"{i}. De: {e['de']} | Assunto: {e['assunto']} | {e['trecho'][:200]}" for i, e in enumerate(items))
    try:
        ranked = await llm.generate_json(
            f"""Classifique os e-mails não lidos de {settings.user_name} por prioridade.
Alta: exige ação ou resposta dele (prazos, cobranças, pedidos diretos, documentos, segurança da conta).
Baixa: newsletters, promoções, notificações automáticas. Média: o resto.
Para cada um: motivo em até 12 palavras e, se houver, a ação sugerida em até 8 palavras.

{lista}""",
            schema,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("classificação de e-mails falhou: %s", exc)
        ranked = []
    atencao, relevantes = [], []
    for r in ranked or []:
        i = r.get("indice")
        if not (isinstance(i, int) and 0 <= i < len(items)):
            continue
        item = {**items[i], "motivo": r.get("motivo"), "acao": r.get("acao")}
        if r.get("prioridade") == "alta":
            atencao.append(item)
        elif r.get("prioridade") == "media":
            relevantes.append(item)
    return {"total": total, "atencao": atencao[:6], "relevantes": relevantes[:4], "outros": max(0, len(items) - len(atencao))}


async def _agenda(cfg: dict) -> list[dict]:
    """Próximos 7 dias; o de hoje é filtrado no build."""
    if not cfg.get("agendas"):
        return []
    return await agenda_src.fetch(cfg["agendas"], cfg.get("fuso", "America/Maceio"), dias=7)


async def _news(cfg: dict) -> list[dict]:
    n = int(cfg.get("noticias_por_tema", 3))
    temas = [t for t in cfg.get("temas", []) if t.strip()]
    res = await asyncio.gather(
        *[asyncio.to_thread(news_src.by_topic, t, n, cfg.get("fontes") or None) for t in temas],
        return_exceptions=True,
    )
    return [
        {"tema": t, "itens": r}
        for t, r in zip(temas, res)
        if not isinstance(r, BaseException) and r
    ]


def _health() -> dict | None:
    from .sources import health

    data = store.get("saude")
    return health.summary(data) if data else None


def _fallback_script(data: dict) -> dict:
    segs = []
    c = data.get("clima")
    if c and "erro" not in c:
        segs.append({"cartao": "clima", "fala": f"Em {c['cidade']}, {c['temperatura']} graus agora, máxima de {c['maxima']} e {c['chuva']}% de chance de chuva."})
    e = data["emails"]
    if e["total"]:
        segs.append({"cartao": "emails", "fala": f"Há {e['total']} e-mails não lidos; {len(e['atencao'])} pedem sua atenção."})
    ag = data["agenda"]
    segs.append({"cartao": "agenda", "fala": f"Você tem {len(ag)} compromissos hoje." if ag else "Sua agenda de hoje está livre."})
    for n in data["noticias"]:
        segs.append({"cartao": f"noticia:{n['tema']}", "fala": f"Em {n['tema']}: {n['itens'][0]['titulo']}."})
    return {"abertura": "Bom dia. Aqui está o seu resumo.", "segmentos": segs, "fechamento": "Tenha um ótimo dia."}


async def _script(data: dict) -> dict:
    keys = ["clima", "emails", "agenda"] + (["saude"] if data.get("saude") else []) + [f"noticia:{n['tema']}" for n in data["noticias"]]
    schema = {
        "type": "OBJECT",
        "properties": {
            "abertura": {"type": "STRING"},
            "segmentos": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {"cartao": {"type": "STRING", "enum": keys}, "fala": {"type": "STRING"}},
                    "required": ["cartao", "fala"],
                },
            },
            "fechamento": {"type": "STRING"},
        },
        "required": ["abertura", "segmentos", "fechamento"],
    }
    from .memory import memory

    resumo = {
        "clima": data.get("clima"),
        "emails": {"total": data["emails"]["total"], "atencao": [
            {k: e.get(k) for k in ("de", "assunto", "motivo", "acao")} for e in data["emails"]["atencao"]
        ]},
        "agenda": data["agenda"],
        "noticias": [{"tema": n["tema"], "itens": [{k: i.get(k) for k in ("titulo", "fonte", "trecho")} for i in n["itens"]]} for n in data["noticias"]],
        "configurado": data["configurado"],
        "saude": data.get("saude"),
    }
    try:
        return await llm.generate_json(
            f"""Você é J.A.R.V.I.S. e vai ler em voz alta o briefing da manhã de {settings.user_name}.
Hoje é {data['hoje']}. Escreva em português do Brasil, falado, natural, com um toque de humor seco.
Duração total de 60 a 90 segundos. Números por extenso só quando ficar mais natural.
Ordem: comece pelo que exige ação (e-mails importantes, compromissos), depois clima, depois saúde (sono e passos de ontem, se houver), depois notícias.
Um segmento por cartão; cada segmento com 1 a 3 frases. Não cite links. Não invente nada além dos dados.
Se e-mails ou agenda não estiverem configurados, não crie segmento para eles.
Feche com uma frase curta de foco para o dia.

O que você sabe sobre ele:
{memory.prompt_block(15)}

Dados:
{resumo}""",
            schema,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("roteiro falhou, usando o simples: %s", exc)
        return _fallback_script(data)


async def build(force: bool = False) -> dict:
    cfg = store.get("briefing")
    last = store.get("briefing_ultimo")
    if not force and last and time.time() - last.get("ts", 0) < cfg.get("atualizar_min", 15) * 60:
        return last
    tz = ZoneInfo(cfg.get("fuso", "America/Maceio"))
    erros: list[str] = []

    async def safe(name: str, coro, default):
        try:
            return await coro
        except Exception as exc:  # noqa: BLE001
            log.warning("briefing: %s falhou: %s", name, exc)
            erros.append(f"{name}: {str(exc)[:140]}")
            return default

    clima, emails, semana, noticias = await asyncio.gather(
        safe("clima", _weather(cfg), None),
        safe("e-mails", _emails(cfg), {"total": 0, "atencao": [], "relevantes": [], "outros": 0}),
        safe("agenda", _agenda(cfg), []),
        safe("notícias", _news(cfg), []),
    )
    now = dt.datetime.now(tz)
    hoje_iso = now.strftime("%Y-%m-%d")
    agenda = [e for e in semana if e.get("data") == hoje_iso]
    dias = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado", "domingo"]
    data = {
        "ts": time.time(),
        "gerado": now.strftime("%H:%M"),
        "hoje": f"{dias[now.weekday()]}, {now.strftime('%d/%m/%Y')}",
        "clima": clima,
        "emails": emails,
        "agenda": agenda,
        "agenda_semana": semana,
        "noticias": noticias,
        "configurado": {"gmail": bool(cfg.get("gmail")), "agenda": bool(cfg.get("agendas"))},
        "saude": _health(),
        "erros": erros,
    }
    data["roteiro"] = await _script(data)
    store.put("briefing_ultimo", data)
    return data


def card_for(key: str, data: dict) -> tuple[str, dict] | None:
    """Cartão (tipo, dados) que acompanha um segmento do roteiro."""
    if key == "clima" and data.get("clima") and "erro" not in data["clima"]:
        return "clima", data["clima"]
    if key == "emails":
        e = data["emails"]
        return "emails", {"titulo": "Pedem sua atenção", "total": e["total"], "itens": e["atencao"], "outros": e["outros"], "configurado": data["configurado"]["gmail"]}
    if key == "agenda":
        return "agenda", {"titulo": "Agenda de hoje", "eventos": data["agenda"], "hoje": data["hoje"], "configurado": data["configurado"]["agenda"]}
    if key == "saude" and data.get("saude"):
        return "saude", data["saude"]
    if key.startswith("noticia:"):
        tema = key.split(":", 1)[1]
        for n in data["noticias"]:
            if n["tema"] == tema:
                return "noticia", {"tema": tema, "itens": n["itens"]}
    return None


def sequence(data: dict) -> tuple[str, list[tuple[int, str, dict]]]:
    """Texto completo a ser falado e a fila (palavras faladas antes do cartão, tipo, dados)."""
    rot = data["roteiro"]
    parts = [rot.get("abertura", "")]
    queue: list[tuple[float, str, dict]] = []
    words = len(rot.get("abertura", "").split())
    for seg in rot.get("segmentos", []):
        card = card_for(seg.get("cartao", ""), data)
        if card:
            queue.append((words, card[0], card[1]))
        parts.append(seg.get("fala", ""))
        words += len(seg.get("fala", "").split())
    parts.append(rot.get("fechamento", ""))
    return " ".join(p for p in parts if p), queue


async def refresh_loop() -> None:
    """Mantém o briefing pronto, para o "bom dia" responder na hora."""
    await asyncio.sleep(20)
    while True:
        try:
            if settings.gemini_api_key:
                await build()
        except Exception as exc:  # noqa: BLE001
            log.warning("atualização do briefing falhou: %s", exc)
        await asyncio.sleep(max(5, store.get("briefing").get("atualizar_min", 15)) * 60)
