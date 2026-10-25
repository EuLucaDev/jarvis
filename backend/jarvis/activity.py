"""Memória de trabalho do dia e iniciativa com bom senso.

- A cada 20 s guarda qual app/janela/aba estava na frente (só quando muda), no mesmo SQLite local.
  Serve para "Jarvis, onde eu parei?" e "volta para o que eu estava fazendo". Fica 7 dias e não sai do Mac.
- Sugestões discretas no canto do HUD, sem falar nada: endereço ou link copiado, muito tempo na mesma janela.
  Aceitar é um toque (ou polegar para cima); ignorar não custa nada.
- Modo foco a dois: avisos não urgentes ficam guardados e viram um resumo quando o foco termina.
"""

import asyncio
import logging
import re
import time
import uuid
from typing import Any

from . import store
from .hub import hub
from .memory import _db

log = logging.getLogger("jarvis.activity")

GUARDAR_DIAS = 7
_last: tuple[str, str] | None = None
_since = time.time()
_sugeridas: set[str] = set()
_clip_count = -1


def _table() -> None:
    with _db() as con:
        con.execute("create table if not exists atividade (id integer primary key, em real, app text, janela text, url text)")


def log_front() -> None:
    global _last, _since
    from . import pc

    try:
        app = pc.front_app()
        janela = pc.front_window_title()
    except Exception:  # noqa: BLE001
        return
    if not app or pc.front_is_jarvis() or app in ("loginwindow", "ScreenSaverEngine"):
        return
    chave = (app, janela)
    if chave == _last:
        return
    _last, _since = chave, time.time()
    url = None
    try:
        url = pc.browser_url(app)
    except Exception:  # noqa: BLE001
        pass
    with _db() as con:
        con.execute("insert into atividade (em, app, janela, url) values (?, ?, ?, ?)", (time.time(), app, janela[:200], url))
        con.execute("delete from atividade where em < ?", (time.time() - GUARDAR_DIAS * 86400,))


def recent(horas: float = 8) -> dict[str, Any]:
    """Linha do tempo do que esteve na frente, juntando trechos seguidos do mesmo app/janela."""
    _table()
    with _db() as con:
        rows = con.execute("select em, app, janela, url from atividade where em > ? order by em", (time.time() - horas * 3600,)).fetchall()
    trechos: list[dict[str, Any]] = []
    for i, r in enumerate(rows):
        fim = rows[i + 1]["em"] if i + 1 < len(rows) else time.time()
        dur = (fim - r["em"]) / 60
        if trechos and trechos[-1]["app"] == r["app"] and trechos[-1]["janela"] == r["janela"]:
            trechos[-1]["minutos"] += dur
            continue
        trechos.append({"inicio": time.strftime("%H:%M", time.localtime(r["em"])), "app": r["app"], "janela": r["janela"], "url": r["url"], "minutos": dur})
    trechos = [t for t in trechos if t["minutos"] >= 1.5]  # passadas rápidas não contam
    por_app: dict[str, float] = {}
    for t in trechos:
        por_app[t["app"]] = por_app.get(t["app"], 0) + t["minutos"]
    for t in trechos:
        t["minutos"] = round(t["minutos"])
    return {
        "trechos": trechos[-25:],
        "tempo_por_app_min": {k: round(v) for k, v in sorted(por_app.items(), key=lambda x: -x[1])[:8]},
    }


async def suggest(texto: str, pedido: str, chave: str) -> None:
    if chave in _sugeridas:
        return
    _sugeridas.add(chave)
    await hub.broadcast({"type": "sugestao", "id": uuid.uuid4().hex[:6], "texto": texto, "pedido": pedido})


ENDERECO = re.compile(r"\b(rua|r\.|av\.|avenida|alameda|travessa|rodovia|praça)\s+\w+.*\d", re.I)
CEP = re.compile(r"\b\d{5}-?\d{3}\b")
URL = re.compile(r"^https?://\S+$")


async def _check_clipboard() -> None:
    """Olha o que foi copiado (só o texto curto, nada é guardado) para sugerir algo útil."""
    global _clip_count
    from . import pc

    texto = (await asyncio.to_thread(pc.clipboard_text)).strip()
    marca = hash(texto)
    if _clip_count == -1 or marca == _clip_count:
        _clip_count = marca
        return
    _clip_count = marca
    if not texto or len(texto) > 300:
        return
    curto = texto if len(texto) < 60 else texto[:57] + "…"
    if ENDERECO.search(texto) or CEP.search(texto):
        await suggest(f"Endereço copiado: {curto}. Abrir no mapa?", f"Abra no navegador o mapa deste endereço: {texto}", f"end:{texto}")
    elif URL.match(texto):
        await suggest("Link copiado. Quer um resumo da página?", f"Pesquise e me resuma em um cartão o conteúdo deste link: {texto}", f"url:{texto}")


async def _check_long_window() -> None:
    if not _last or time.time() - _since < 45 * 60:
        return
    app, janela = _last
    chave = f"longa:{app}:{janela}:{time.strftime('%Y-%m-%d')}"
    await suggest(
        f"Há 45 min em {app}. Quer ajuda para terminar isso?",
        f"Estou há 45 minutos em {app} ({janela[:80]}). Veja o contexto atual e me ofereça ajuda concreta para terminar.",
        chave,
    )


async def _check_focus() -> None:
    fim = hub.focus_until
    if not fim or time.time() < fim:
        return
    hub.focus_until = 0
    fila, hub.focus_queue = hub.focus_queue, []
    from . import alerts

    if fila:
        resumo = "; ".join(f"{a['titulo']}: {a['texto']}" for a in fila[:8])
        await alerts.notify("Fim do foco", f"Enquanto você focava chegaram {len(fila)} avisos. {resumo}", "info")
    else:
        await alerts.notify("Fim do foco", "Nada novo chegou enquanto você focava.", "info")
    await hub.broadcast({"type": "foco", "ate": 0})


async def loop() -> None:
    _table()
    while True:
        cfg = store.get("atividade")
        try:
            from . import pc

            if pc.permitido():
                if cfg.get("registrar", True):
                    await asyncio.to_thread(log_front)
                if cfg.get("sugestoes", True):
                    await _check_clipboard()
                    await _check_long_window()
            await _check_focus()
        except Exception as exc:  # noqa: BLE001 - laço de fundo não pode morrer
            log.warning("atividade: %s", exc)
        await asyncio.sleep(20)
