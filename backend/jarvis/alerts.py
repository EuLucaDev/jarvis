"""Alertas proativos: o Jarvis avisa sem você perguntar.

- Compromisso começando em N minutos (agenda do briefing).
- E-mail urgente novo (comparado com o que já foi avisado).
- Ativo da carteira com movimento forte no dia.

Cada aviso vai para o HUD, vira notificação do Mac e, se a voz estiver ao vivo, o Jarvis fala.
No horário de silêncio só fica registrado.
"""

import asyncio
import datetime as dt
import logging
import subprocess
import time
import uuid
from typing import Any

from . import store
from .hub import hub

log = logging.getLogger("jarvis.alerts")

RECENT: list[dict[str, Any]] = []  # últimos avisos, para quem abrir o HUD depois


def _cfg() -> dict[str, Any]:
    return store.get("alertas")


def _quiet(cfg: dict[str, Any]) -> bool:
    ini, fim = cfg.get("silencio") or ["22:00", "07:00"]
    now = dt.datetime.now().strftime("%H:%M")
    return (ini <= now or now < fim) if ini > fim else (ini <= now < fim)


def _seen(key: str) -> bool:
    st = store.get("alertas_estado") or {}
    return key in st.get("vistos", [])


def _mark(key: str) -> None:
    st = store.get("alertas_estado") or {}
    st["vistos"] = (st.get("vistos", []) + [key])[-400:]
    store.put("alertas_estado", st)


async def notify(titulo: str, texto: str, nivel: str = "info", falar: bool = True) -> dict[str, Any]:
    cfg = _cfg()
    alert = {"id": uuid.uuid4().hex[:8], "titulo": titulo, "texto": texto, "nivel": nivel, "at": time.strftime("%H:%M")}
    RECENT[:] = (RECENT + [alert])[-20:]
    # modo foco a dois: o que não é urgente espera o fim do foco e vira um resumo só
    if hub.focus_until and time.time() < hub.focus_until and nivel != "alta" and titulo != "Fim do foco":
        hub.focus_queue.append(alert)
        return alert
    quiet = _quiet(cfg)
    await hub.broadcast({"type": "alerta", **alert, "silencioso": quiet})
    if quiet:
        return alert
    if cfg.get("notificacao_mac", True):
        safe = lambda s: s.replace('"', "'")  # noqa: E731
        subprocess.run(
            ["osascript", "-e", f'display notification "{safe(texto)}" with title "Jarvis" subtitle "{safe(titulo)}"'],
            capture_output=True,
        )
    bridge = hub.voice
    if falar and cfg.get("falar", True) and bridge and bridge.session:
        await bridge.send_text(
            f"[Aviso do sistema, não é o usuário falando. Anuncie em uma frase curta e natural, sem perguntar nada.] {titulo}: {texto}"
        )
    return alert


async def _check_agenda(cfg: dict[str, Any]) -> None:
    b = store.get("briefing_ultimo") or {}
    mins = int(cfg.get("agenda_min", 10))
    now = dt.datetime.now()
    for e in b.get("agenda_semana") or b.get("agenda") or []:
        if e.get("dia_todo") or not e.get("inicio") or e.get("data") != now.strftime("%Y-%m-%d"):
            continue
        start = dt.datetime.strptime(f"{e['data']} {e['inicio']}", "%Y-%m-%d %H:%M")
        falta = (start - now).total_seconds() / 60
        key = f"ag:{e['data']}:{e['inicio']}:{e['titulo']}"
        if 0 < falta <= mins and not _seen(key):
            _mark(key)
            onde = f" · {e['local']}" if e.get("local") else ""
            await notify(f"Em {round(falta)} minutos", f"{e['titulo']}{onde}", "agenda")


async def _check_emails(cfg: dict[str, Any]) -> None:
    if not cfg.get("emails", True):
        return
    b = store.get("briefing_ultimo") or {}
    for m in (b.get("emails") or {}).get("atencao", []):
        key = f"em:{m.get('endereco')}:{m.get('assunto')}"
        if _seen(key):
            continue
        _mark(key)
        # primeira passada só registra o que já existia, para não despejar avisos antigos
        if (store.get("alertas_estado") or {}).get("iniciado"):
            await notify(f"E-mail importante de {m.get('de')}", m.get("assunto", ""), "email")
    st = store.get("alertas_estado") or {}
    if not st.get("iniciado"):
        st["iniciado"] = True
        store.put("alertas_estado", st)


async def _check_market(cfg: dict[str, Any]) -> None:
    pct = float(cfg.get("mercado_pct") or 0)
    if pct <= 0 or dt.datetime.now().weekday() >= 5:
        return
    from . import market

    hoje = dt.date.today().isoformat()
    for q in await market.quotes(None, "5d"):
        v = q.get("variacao")
        key = f"mk:{hoje}:{q['simbolo']}"
        if v is not None and abs(v) >= pct and not _seen(key):
            _mark(key)
            sinal = "sobe" if v > 0 else "cai"
            await notify("Mercado", f"{q['nome']} {sinal} {abs(v):.1f}% hoje".replace(".", ","), "mercado")


async def loop() -> None:
    await asyncio.sleep(30)
    tick = 0
    while True:
        cfg = _cfg()
        if cfg.get("ativo", True):
            for check in (_check_agenda, _check_emails) + ((_check_market,) if tick % 15 == 0 else ()):
                try:
                    await check(cfg)
                except Exception as exc:  # noqa: BLE001
                    log.warning("alerta %s falhou: %s", check.__name__, exc)
        tick += 1
        await asyncio.sleep(60)
