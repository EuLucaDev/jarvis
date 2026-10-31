"""Imagens e PDFs no visual do Jarvis, desenhados pela própria interface (/impressao) num Chromium sem tela.

- `cartao(card)`: o cartão como aparece na tela, em PNG (vai como foto no Telegram).
- `relatorio(mes, formato)`: o relatório do financeiro do mês; "imagem" = a 1ª página (resumo) em PNG, "pdf" =
  o documento A4 inteiro, "ambos" = os dois.
Desenha com o Playwright, se estiver instalado (desenvolvimento); no computador da pessoa, com o navegador que
ela já tem (Chrome, Edge, Brave ou Chromium) em modo sem janela, sem aumentar o instalador do Jarvis.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
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


def _tem_playwright() -> bool:
    try:
        import playwright  # noqa: F401

        return True
    except ImportError:
        return False


def navegador_do_sistema() -> str | None:
    """Chrome, Edge, Brave ou Chromium instalado (o Windows sempre tem o Edge)."""
    if sys.platform == "darwin":
        opcoes = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        opcoes += [str(Path.home() / o.lstrip("/")) for o in opcoes]
    elif sys.platform == "win32":
        pf = [os.getenv("PROGRAMFILES(X86)", r"C:\Program Files (x86)"), os.getenv("PROGRAMFILES", r"C:\Program Files"), os.getenv("LOCALAPPDATA", "")]
        opcoes = [str(Path(b) / r) for b in pf if b for r in (r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe",
                                                                r"BraveSoftware\Brave-Browser\Application\brave.exe")]
    else:
        opcoes = [shutil.which(n) or "" for n in ("google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser")]
    return next((o for o in opcoes if o and Path(o).exists()), None)


def _sem_janela(url: str, saida: Path, largura: int, alto: int, pdf: bool) -> None:
    nav = navegador_do_sistema()
    if not nav:
        raise RuntimeError("Para imagens e PDFs o Jarvis usa um navegador (Chrome, Edge ou Brave); instale um deles.")
    with tempfile.TemporaryDirectory() as perfil:
        cmd = [nav, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
               f"--user-data-dir={perfil}", "--virtual-time-budget=10000", f"--window-size={largura},{alto}"]
        cmd += [f"--print-to-pdf={saida}", "--no-pdf-header-footer"] if pdf else ["--force-device-scale-factor=2", f"--screenshot={saida}"]
        subprocess.run([*cmd, url], capture_output=True, timeout=90, check=False)
    if not saida.exists() or saida.stat().st_size == 0:
        raise RuntimeError("O navegador não conseguiu desenhar a página.")


def _recortar(png: bytes, fundo: tuple[int, int, int] = (5, 11, 24)) -> bytes:
    """Tira as sobras do fundo em volta do que foi desenhado (a janela sem cabeça tem tamanho fixo)."""
    import io

    from PIL import Image, ImageChops

    im = Image.open(io.BytesIO(png)).convert("RGB")
    caixa = ImageChops.difference(im, Image.new("RGB", im.size, fundo)).point(lambda v: 255 if v > 18 else 0).getbbox()
    if caixa:
        im = im.crop((0, 0, im.width, min(im.height, caixa[3] + 24)))
    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue()


async def _foto_sistema(url: str, largura: int, alto: int) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "foto.png"
        await asyncio.to_thread(_sem_janela, url, f, largura, alto, False)
        return _recortar(f.read_bytes())


async def cartao(card: dict[str, Any]) -> bytes:
    if not _tem_playwright():
        return await _foto_sistema(f"{_base()}/impressao?cartao={card['id']}", 600, 1400)
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
    if not _tem_playwright():
        if formato in ("imagem", "ambos"):
            out.append((f"{nome}.png", await _foto_sistema(f"{_base()}/impressao?relatorio={mes}&so=resumo", 794, 1300), "imagem"))
        if formato in ("pdf", "ambos"):
            with tempfile.TemporaryDirectory() as d:
                f = Path(d) / "relatorio.pdf"
                await asyncio.to_thread(_sem_janela, f"{_base()}/impressao?relatorio={mes}", f, 794, 1123, True)
                out.append((f"{nome}.pdf", f.read_bytes(), "documento"))
        return out
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
