"""Notícias por tema, grátis: DuckDuckGo (traz imagem) e RSS do Google Notícias como reserva."""

import email.utils
import logging
import xml.etree.ElementTree as ET
from typing import Any

import httpx

log = logging.getLogger("jarvis.news")


def google_news(consulta: str, limit: int = 8) -> list[dict[str, Any]]:
    r = httpx.get(
        "https://news.google.com/rss/search",
        params={"q": f"{consulta} when:7d", "hl": "pt-BR", "gl": "BR", "ceid": "BR:pt-419"},
        timeout=10,
        follow_redirects=True,
    )
    out = []
    for item in ET.fromstring(r.text).findall("./channel/item")[:limit]:
        title = item.findtext("title") or ""
        source = item.findtext("source") or ""
        if source and title.endswith(f" - {source}"):
            title = title[: -len(source) - 3]
        date = item.findtext("pubDate")
        try:
            date = email.utils.parsedate_to_datetime(date).strftime("%d/%m/%Y %H:%M") if date else None
        except (TypeError, ValueError):
            pass
        out.append({"titulo": title, "fonte": source, "data": date, "url": item.findtext("link")})
    return out


def ddg_news(consulta: str, limit: int = 8) -> list[dict[str, Any]]:
    from ddgs import DDGS

    rows = DDGS().news(consulta, region="br-pt", timelimit="w", max_results=limit)
    out = []
    for r in rows:
        date = r.get("date") or ""
        out.append({
            "titulo": r.get("title"),
            "trecho": r.get("body"),
            "url": r.get("url"),
            "fonte": r.get("source"),
            "data": date[:10] if date else None,
            "imagem": r.get("image"),
        })
    return out


def by_topic(tema: str, n: int, fontes: list[str] | None = None) -> list[dict[str, Any]]:
    """As n notícias mais relevantes do tema; prefere as com imagem e as das fontes escolhidas."""
    consulta = tema
    if fontes:
        consulta += " (" + " OR ".join(f"site:{f}" for f in fontes[:4]) + ")"
    items: list[dict[str, Any]] = []
    try:
        items = ddg_news(consulta)
        if fontes and len(items) < n:
            items += ddg_news(tema)
    except Exception as exc:  # noqa: BLE001
        log.warning("ddg news falhou (%s): %s", tema, exc)
    if len(items) < n:
        try:
            items += google_news(tema)
        except Exception as exc:  # noqa: BLE001
            log.warning("google news falhou (%s): %s", tema, exc)
    seen, uniq = set(), []
    for it in items:
        key = (it.get("titulo") or "").lower()[:60]
        if key and key not in seen:
            seen.add(key)
            uniq.append(it)
    uniq.sort(key=lambda x: 0 if x.get("imagem") else 1)
    return uniq[:n]
