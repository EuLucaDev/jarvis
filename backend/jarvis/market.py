"""Cotações grátis: Yahoo Finance (bolsa, cripto, câmbio) sem chave.

- `quotes`: o cartão "Mercado agora" (preço arredondado para mostrar, série de 30 dias).
- `cotacoes`: para o mentor de investimentos — preço sem arredondar, moeda, bolsa, horário do dado
  (regularMarketTime), horário da coleta, fonte e atraso conhecido. Sem resposta, o ativo volta com erro (nunca
  um número). Cache de 60 s para a voz e o Telegram não repetirem a mesma consulta.
"""

import asyncio
import datetime as dt
import logging
import time
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


_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
B3 = ("3", "4", "5", "6", "11", "34", "39")  # finais de ticker da B3 (ações, units/FIIs/ETFs, BDRs)


def simbolo_yahoo(s: str) -> str:
    s = s.strip().upper()
    if "." in s or "-" in s or "=" in s or s.startswith("^"):
        return s
    if len(s) >= 5 and s[:4].isalpha() and s[4:] in B3:
        return s + ".SA"
    return s


async def _detalhe(http: httpx.AsyncClient, pedido: str) -> dict[str, Any]:
    sym = simbolo_yahoo(pedido)
    agora = time.time()
    if sym in _CACHE and agora - _CACHE[sym][0] < 60:
        return _CACHE[sym][1]
    base = {"pedido": pedido, "simbolo": sym, "fonte": "Yahoo Finance (não oficial)"}
    try:
        r = await http.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}", params={"range": "5d", "interval": "1d"},
                           headers={"User-Agent": "Mozilla/5.0"})
        if r.status_code != 200:
            return {**base, "erro": f"sem dado (HTTP {r.status_code})"}
        res = (r.json().get("chart") or {}).get("result") or []
        meta = res[0]["meta"] if res else None
        preco = meta and meta.get("regularMarketPrice")
        if not preco:
            return {**base, "erro": "a fonte não trouxe preço"}
        quando = meta.get("regularMarketTime")
        out = {
            **base, "nome": meta.get("longName") or meta.get("shortName"), "preco": preco, "moeda": meta.get("currency"),
            "bolsa": meta.get("fullExchangeName") or meta.get("exchangeName"), "tipo": meta.get("instrumentType"),
            "horario_do_dado": dt.datetime.fromtimestamp(quando, dt.timezone.utc).isoformat() if quando else None,
            "coletado_em": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "fechamento_anterior": meta.get("chartPreviousClose") or meta.get("previousClose"),
            "atraso": "bolsa costuma vir com atraso de ~15 min; fora do pregão é o último negócio",
        }
        _CACHE[sym] = (agora, out)
        return out
    except Exception as exc:  # noqa: BLE001
        return {**base, "erro": f"a fonte não respondeu ({type(exc).__name__})"}


async def cotacoes(simbolos: list[str]) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=8) as http:
        return list(await asyncio.gather(*[_detalhe(http, s) for s in simbolos]))
