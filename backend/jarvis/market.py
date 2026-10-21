"""Cotações grátis: Yahoo Finance (bolsa, cripto, câmbio) sem chave."""

import asyncio
import logging
from typing import Any

import httpx

from . import store

log = logging.getLogger("jarvis.market")

NOMES = {"^BVSP": "Ibovespa", "BRL=X": "Dólar", "EURBRL=X": "Euro", "BTC-USD": "Bitcoin", "^GSPC": "S&P 500", "^IXIC": "Nasdaq"}


async def _quote(http: httpx.AsyncClient, symbol: str, periodo: str) -> dict[str, Any] | None:
    r = await http.get(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}",
        params={"range": periodo, "interval": "1d" if periodo != "1d" else "15m"},
        headers={"User-Agent": "Mozilla/5.0"},
    )
    if r.status_code != 200:
        return None
    res = r.json()["chart"]["result"][0]
    meta = res["meta"]
    closes = [c for c in res["indicators"]["quote"][0].get("close", []) if c is not None]
    if not closes:
        return None
    price = meta.get("regularMarketPrice") or closes[-1]
    # variação do dia: fechamento anterior, não o início do período
    prev = meta.get("previousClose") or meta.get("regularMarketPreviousClose") or (closes[-2] if len(closes) > 1 else None)
    return {
        "simbolo": symbol,
        "nome": NOMES.get(symbol) or (symbol.replace(".SA", "") if symbol.endswith(".SA") else meta.get("shortName") or symbol),
        "preco": round(price, 2 if price < 1000 else 0),
        "moeda": meta.get("currency"),
        "variacao": round((price / prev - 1) * 100, 2) if prev else None,
        "serie": [round(c, 2) for c in closes[-30:]],
    }


async def quotes(symbols: list[str] | None = None, periodo: str = "1mo") -> list[dict[str, Any]]:
    symbols = symbols or (store.get("mercado") or {}).get("ativos") or list(NOMES)[:4]
    async with httpx.AsyncClient(timeout=10) as http:
        res = await asyncio.gather(*[_quote(http, s, periodo) for s in symbols], return_exceptions=True)
    out = [r for r in res if isinstance(r, dict)]
    for s, r in zip(symbols, res):
        if not isinstance(r, dict):
            log.warning("cotação falhou: %s %s", s, r)
    return out
