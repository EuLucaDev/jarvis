"""Navegador à vista, nos três sistemas: abas, pesquisa com os resultados abertos em abas, achar na página,
rolar, zoom e ler a página aberta (para ler em voz alta ou resumir).

Atalhos usam "cmd" (no Windows e no Linux viram Ctrl). Antes de teclar, o navegador vem para a frente: se o
HUD do Jarvis estiver na frente, as teclas iriam para ele.
"""

import re
import time
from html.parser import HTMLParser
from typing import Any
from urllib.parse import quote_plus

from . import overlay, pc
from .pc.common import NAVEGADORES

TEXTO_MAX = 20000
SITES = {  # "pesquisa no YouTube" → busca direto no site
    "youtube": "https://www.youtube.com/results?search_query={q}",
    "google": "https://www.google.com/search?q={q}",
    "imagens": "https://www.google.com/search?tbm=isch&q={q}",
    "maps": "https://www.google.com/maps/search/{q}",
    "mapa": "https://www.google.com/maps/search/{q}",
    "wikipedia": "https://pt.wikipedia.org/w/index.php?search={q}",
    "mercado livre": "https://lista.mercadolivre.com.br/{q}",
    "amazon": "https://www.amazon.com.br/s?k={q}",
    "github": "https://github.com/search?q={q}",
    "spotify": "https://open.spotify.com/search/{q}",
    "noticias": "https://news.google.com/search?q={q}&hl=pt-BR",
}
TECLAS = {
    "fechar_aba": "cmd+w", "proxima_aba": "ctrl+tab", "aba_anterior": "ctrl+shift+tab", "reabrir_aba": "cmd+shift+t",
    "recarregar": "cmd+r", "nova_janela": "cmd+n", "janela_anonima": "cmd+shift+n", "favoritar": "cmd+d",
    "zoom_mais": "cmd+=", "zoom_menos": "cmd+-", "zoom_normal": "cmd+0", "historico": "cmd+y",
}


def _navegador_na_frente() -> dict[str, Any] | None:
    """Garante que as teclas vão para o navegador (e não para o HUD)."""
    frente = (pc.front_app() or "").lower()
    if not pc.front_is_jarvis() and any(n.lower() == frente or n.lower() in frente for n in NAVEGADORES):
        return None
    r = pc.janela_app("navegador", "focar")
    if r.get("erro"):
        return {"erro": "Não achei um navegador aberto. Peça para abrir uma aba primeiro."}
    time.sleep(0.35)
    return None


def _mostrar(rotulo: str) -> None:
    r = pc.front_rect()
    if r:
        x, y, w, _ = r
        overlay.look(x, y, w, 90, label=rotulo)  # a faixa de cima da janela (abas e endereço)


def acao(acao: str, valor: str = "", site: str = "") -> dict[str, Any]:
    if acao in ("nova_aba", "abrir"):
        r = pc.browser("nova_aba", valor)
        time.sleep(0.7)
        _mostrar("Nova aba")
        return r
    if acao == "buscar":
        modelo = SITES.get(site.lower().strip(), SITES["google"])
        url = modelo.format(q=quote_plus(valor))
        r = pc.browser("nova_aba", url)
        time.sleep(0.7)
        _mostrar(f"Pesquisando {valor}"[:60])
        return {**r, "url": url}
    if acao == "abrir_resultados":
        return abrir_resultados(valor)
    if acao == "ler_pagina":
        return ler_pagina()
    if acao in ("voltar", "avancar"):
        if (e := _navegador_na_frente()):
            return e
        _mostrar("Voltando" if acao == "voltar" else "Avançando")
        return pc.browser(acao)
    if acao == "ir_para_aba":
        if (e := _navegador_na_frente()):
            return e
        n = max(1, min(9, int(re.sub(r"\D", "", valor) or 1)))
        _mostrar(f"Aba {n}")
        return pc.press(f"cmd+{n}")
    if acao == "localizar":
        if (e := _navegador_na_frente()):
            return e
        _mostrar(f"Procurando “{valor}”"[:60])
        pc.press("cmd+f")
        time.sleep(0.25)
        pc.type_text(valor)
        return {"ok": True}
    if acao in ("rolar_baixo", "rolar_cima"):
        if (e := _navegador_na_frente()):
            return e
        pc.scroll(-600 if acao == "rolar_baixo" else 600)
        return {"ok": True}
    if acao in TECLAS:
        if (e := _navegador_na_frente()):
            return e
        _mostrar(acao.replace("_", " ").capitalize())
        return pc.press(TECLAS[acao])
    return {"erro": f"Ação de navegador desconhecida: {acao}"}


def abrir_resultados(consulta: str, n: int = 3) -> dict[str, Any]:
    """Pesquisa e abre os melhores resultados, cada um numa aba."""
    from .tools import _search

    try:
        res = [r for r in _search(consulta, "geral") if r.get("url")][:n]
    except Exception as exc:  # noqa: BLE001
        return {"erro": f"A busca falhou: {exc}"[:200]}
    if not res:
        return {"erro": "A busca não trouxe resultados."}
    for r in res:
        pc.browser("nova_aba", r["url"])
        time.sleep(0.5)
    _mostrar(f"{len(res)} abas abertas")
    return {"ok": True, "abertos": [{"titulo": r.get("titulo"), "url": r["url"]} for r in res]}


class _Texto(HTMLParser):
    PULAR = {"script", "style", "noscript", "svg", "nav", "footer", "header", "form", "aside", "button"}

    def __init__(self) -> None:
        super().__init__()
        self.partes: list[str] = []
        self.titulo = ""
        self._pular = 0
        self._no_titulo = False

    def handle_starttag(self, tag, attrs):
        if tag in self.PULAR:
            self._pular += 1
        elif tag == "title":
            self._no_titulo = True
        elif tag in ("p", "br", "li", "h1", "h2", "h3", "h4", "tr", "div", "section", "article"):
            self.partes.append("\n")

    def handle_endtag(self, tag):
        if tag in self.PULAR and self._pular:
            self._pular -= 1
        elif tag == "title":
            self._no_titulo = False

    def handle_data(self, data):
        if self._no_titulo:
            self.titulo += data
        elif not self._pular:
            self.partes.append(data)


def _limpo(texto: str) -> str:
    linhas = [" ".join(ln.split()) for ln in texto.splitlines()]
    return "\n".join(ln for ln in linhas if len(ln) > 1)


def ler_pagina() -> dict[str, Any]:
    """Texto da aba aberta: baixa o endereço (páginas públicas) ou, se não der (login, app web), seleciona
    tudo e copia, à vista, devolvendo a área de transferência como estava."""
    import httpx

    app = pc.front_app() if not pc.front_is_jarvis() else ""
    if not app or not any(n.lower() in app.lower() or app.lower() in n.lower() for n in NAVEGADORES):
        if (e := _navegador_na_frente()):
            return e
        app = pc.front_app()
    url = pc.browser_url(app) if app else None
    _mostrar("Lendo a página")
    if url and url.startswith("http"):
        try:
            r = httpx.get(url, timeout=10, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0 (Jarvis)"})
            if r.status_code == 200 and "html" in r.headers.get("content-type", ""):
                p = _Texto()
                p.feed(r.text)
                texto = _limpo("".join(p.partes))
                if len(texto) > 400:
                    return {"ok": True, "url": url, "titulo": " ".join(p.titulo.split()), "texto": texto[:TEXTO_MAX],
                            "cortado": len(texto) > TEXTO_MAX}
        except Exception:  # noqa: BLE001 - cai para copiar da tela
            pass
    # selecionar tudo e copiar (funciona em páginas com login)
    antes = pc.clipboard_text()
    pc.press("cmd+a")
    time.sleep(0.15)
    pc.press("cmd+c")
    time.sleep(0.4)
    texto = _limpo(pc.clipboard_text() or "")
    pc.set_clipboard(antes or "")
    pc.press("esc")
    if len(texto) < 40:
        return {"erro": "Não consegui ler o texto dessa página."}
    return {"ok": True, "url": url, "texto": texto[:TEXTO_MAX], "cortado": len(texto) > TEXTO_MAX}
