"""Imagens e PDFs no visual do Jarvis, desenhados pela própria interface (/impressao) num Chromium sem tela.

- `cartao(card)`: o cartão como aparece na tela, em PNG (vai como foto no Telegram).
- `relatorio(mes, formato)`: o relatório do financeiro do mês; "imagem" = a 1ª página (resumo) em PNG, "pdf" =
  o documento A4 inteiro, "ambos" = os dois.
O navegador abre uma vez e fica aberto (cada desenho leva menos de um segundo depois disso).
Precisa do Playwright com o Chromium (grupo "nuvem" das dependências; a imagem Docker da nuvem já traz).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

from .config import settings

log = logging.getLogger("jarvis.impressao")

_pw = None
_nav = None
_trava = asyncio.Lock()
MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]


def _base() -> str:
    return f"http://127.0.0.1:{os.getenv('JARVIS_PORT', settings.port)}"


async def _navegador():
    global _pw, _nav
    if _nav and _nav.is_connected():
        return _nav
    from playwright.async_api import async_playwright

    _pw = await async_playwright().start()
    _nav = await _pw.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
    return _nav


async def _pagina(url: str, largura: int, alto: int = 900):
    nav = await _navegador()
    pg = await nav.new_page(viewport={"width": largura, "height": alto}, device_scale_factor=2)
    await pg.goto(url, wait_until="networkidle", timeout=30000)
    await pg.wait_for_function("window.__pronto === true", timeout=20000)
    return pg


async def cartao(card: dict[str, Any]) -> bytes:
    async with _trava:
        pg = await _pagina(f"{_base()}/impressao?cartao={card['id']}", 600)
        try:
            return await pg.locator("#alvo").screenshot(type="png")
        finally:
            await pg.close()


def rotulo_mes(mes: str) -> str:
    ano, m = mes.split("-")[:2]
    return f"{MESES[int(m) - 1]} de {ano}"


async def dados_relatorio(mes: str) -> dict[str, Any]:
    """O que a página do relatório desenha: o painel do mês do financeiro, os maiores gastos e o mês anterior."""
    from . import finance

    ano, m = int(mes[:4]), int(mes[5:7])
    d = await finance.chamar("dashboard:get", {"year": ano, "month": m})
    gastos = await finance.chamar("expenses:list", {"year": ano, "month": m}) or []
    if isinstance(gastos, dict):
        gastos = gastos.get("items") or []
    maiores = sorted(gastos, key=lambda g: -(g.get("amount") or 0))[:12]
    pa, pm = (ano, m - 1) if m > 1 else (ano - 1, 12)
    try:
        ant = await finance.chamar("dashboard:get", {"year": pa, "month": pm})
        anterior = {"entradas": ant.get("totalIncome", 0), "saidas": ant.get("totalOutflow", 0)}
    except Exception:  # noqa: BLE001
        anterior = None
    return {
        "mes": mes, "rotulo": rotulo_mes(mes), "nome": settings.user_name, "gerado": time.strftime("%d/%m/%Y %H:%M"),
        "d": d, "anterior": anterior,
        "maiores": [{"descricao": g.get("description") or "", "categoria": g.get("category") or "", "valor": g.get("amount") or 0,
                     "data": g.get("date") or ""} for g in maiores],
    }


async def relatorio(mes: str, formato: str = "imagem") -> list[tuple[str, bytes, str]]:
    nome = f"Relatório {rotulo_mes(mes)}"
    out: list[tuple[str, bytes, str]] = []
    async with _trava:
        pg = await _pagina(f"{_base()}/impressao?relatorio={mes}", 794, 1123)  # A4 a 96 dpi
        try:
            if formato in ("imagem", "ambos"):
                out.append((f"{nome}.png", await pg.locator("#resumo").screenshot(type="png"), "imagem"))
            if formato in ("pdf", "ambos"):
                pdf = await pg.pdf(format="A4", print_background=True, margin={"top": "0", "bottom": "0", "left": "0", "right": "0"})
                out.append((f"{nome}.pdf", pdf, "documento"))
        finally:
            await pg.close()
    return out


async def fechar() -> None:
    global _pw, _nav
    if _nav:
        await _nav.close()
    if _pw:
        await _pw.stop()
    _pw = _nav = None
