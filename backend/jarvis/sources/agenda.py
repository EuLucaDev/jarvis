"""Compromissos do dia a partir de links iCal (Google Agenda → Configurações → Endereço secreto em formato iCal)."""

import datetime as dt
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import icalendar
import recurring_ical_events


async def fetch(agendas: list[dict[str, str]], fuso: str, dias: int = 1) -> list[dict[str, Any]]:
    tz = ZoneInfo(fuso)
    start = dt.datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + dt.timedelta(days=dias)
    out: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as http:
        for ag in agendas:
            if not ag.get("url"):
                continue
            r = await http.get(ag["url"].replace("webcal://", "https://"))
            r.raise_for_status()
            cal = icalendar.Calendar.from_ical(r.content)
            for ev in recurring_ical_events.of(cal).between(start, end):
                s = ev.get("DTSTART").dt
                e = ev.get("DTEND").dt if ev.get("DTEND") else None
                all_day = not isinstance(s, dt.datetime)
                if not all_day:
                    s = s.astimezone(tz)
                    e = e.astimezone(tz) if isinstance(e, dt.datetime) else None
                dia = s if not isinstance(s, dt.datetime) else s.date()
                out.append({
                    "data": dia.strftime("%Y-%m-%d"),
                    "agenda": ag.get("nome", ""),
                    "titulo": str(ev.get("SUMMARY", "Sem título")),
                    "local": str(ev.get("LOCATION", "")) or None,
                    "dia_todo": all_day,
                    "inicio": None if all_day else s.strftime("%H:%M"),
                    "fim": e.strftime("%H:%M") if isinstance(e, dt.datetime) else None,
                    "_ord": dia.strftime("%Y-%m-%d") + ("00:00" if all_day else s.strftime("%H:%M")),
                })
    out.sort(key=lambda x: x["_ord"])
    for ev in out:
        ev.pop("_ord", None)
    return out
