"""Respostas do Telegram em texto diagramado (sem imagens): valores alinhados e "gráficos" de barras com
caracteres, dentro de blocos monoespaçados (<pre>) do HTML do Telegram.

- `relatorio(mes)`: o relatório do financeiro do mês (resumo, para onde foi, formas de pagamento, faturas,
  orçamento, metas, maiores gastos), em mensagens prontas.
- `cartao(card)`: um cartão que uma ferramenta mostraria na tela, como texto.
"""

from __future__ import annotations

import html
from typing import Any

MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]
FORMAS = {"PIX": "Pix", "DEBITO": "Débito", "DINHEIRO": "Dinheiro", "CARTAO_CREDITO": "Crédito", "VALE_BENEFICIO": "Vale", "META": "Meta"}
LARGURA = 12  # barras: 12 caracteres = 100%


def e(t: Any) -> str:
    return html.escape(str(t if t is not None else ""), quote=False)


def brl(v: Any, sinal: bool = False) -> str:
    try:
        n = float(v or 0)
    except (TypeError, ValueError):
        return str(v)
    s = f"{abs(n):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    pre = ("-" if n < 0 else "+" if sinal and n > 0 else "")
    return f"{pre}R$ {s}"


def curto(v: Any) -> str:
    """R$ sem centavos para colunas estreitas (1.800, 12,5 mil)."""
    n = abs(float(v or 0))
    if n >= 100000:
        return f"{n / 1000:,.0f} mil".replace(",", ".")
    return f"{n:,.0f}".replace(",", ".")


def barra(v: float, maximo: float, largura: int = LARGURA) -> str:
    """Barra com oitavos de bloco: ▏▎▍▌▋▊▉█ (precisão de 1/8 de caractere)."""
    if maximo <= 0 or v <= 0:
        return "·".ljust(largura)
    oitavos = round(min(1.0, v / maximo) * largura * 8)
    cheios, resto = divmod(oitavos, 8)
    return ("█" * cheios + (" ▏▎▍▌▋▊▉"[resto] if resto else "")).ljust(largura)


def tabela_barras(itens: list[tuple[str, float]], total: float | None = None, nome: int = 12) -> str:
    """Linhas "Categoria  ████▌      1.800  48%" alinhadas."""
    if not itens:
        return ""
    m = max(v for _, v in itens) or 1
    tot = total if total is not None else sum(v for _, v in itens) or 1
    linhas = []
    for rotulo, v in itens:
        r = (rotulo[: nome - 1] + "…") if len(rotulo) > nome else rotulo.ljust(nome)
        linhas.append(f"{e(r)} {barra(v, m)} {curto(v):>7} {round(v / tot * 100):>3}%")
    return "<pre>" + "\n".join(linhas) + "</pre>"


def colunas(pares: list[tuple[str, str]], nome: int = 12) -> str:
    return "<pre>" + "\n".join(f"{e(a).ljust(nome)} {e(b):>15}" for a, b in pares) + "</pre>"


# ---------------------------------------------------------------- relatório do mês


async def relatorio(mes: str, nome: str = "") -> list[str]:
    """O relatório do financeiro do mês em mensagens de texto (cada uma cabe numa mensagem do Telegram)."""
    from . import finance

    ano, m = int(mes[:4]), int(mes[5:7])
    d = await finance.chamar("dashboard:get", {"year": ano, "month": m})
    pa, pm = (ano, m - 1) if m > 1 else (ano - 1, 12)
    try:
        ant = await finance.chamar("dashboard:get", {"year": pa, "month": pm})
    except Exception:  # noqa: BLE001
        ant = None
    gastos = await finance.chamar("expenses:list", {"year": ano, "month": m}) or []
    if isinstance(gastos, dict):
        gastos = gastos.get("items") or []

    entra, sai = float(d.get("totalIncome") or 0), float(d.get("totalOutflow") or 0)
    sobra = float(d.get("leftover") or 0)
    saude = (d.get("intelligence") or {}).get("health") or {}
    titulo = f"📊 <b>{MESES[m - 1].capitalize()} de {ano}</b>" + (f" · {e(nome)}" if nome else "")
    if saude.get("score") is not None:
        titulo += f"\nSaúde financeira: <b>{saude['score']}</b> · {e(saude.get('label', ''))}"

    resumo = [("Entradas", brl(entra)), ("Saídas", brl(sai)), ("Sobra", brl(sobra)),
              ("Guardou", f"{round(float(d.get('savingRate') or 0))}% do que entrou"), ("Saldo total", brl(d.get("totalBalance")))]
    if d.get("openInvoiceTotal"):
        resumo.append(("Faturas abertas", brl(d["openInvoiceTotal"])))
    comp = ""
    if ant and float(ant.get("totalOutflow") or 0):
        var = (sai - float(ant["totalOutflow"])) / float(ant["totalOutflow"]) * 100
        seta = "▲" if var > 0 else "▼"
        comp = f"\n{seta} Saídas {abs(round(var))}% {'acima' if var > 0 else 'abaixo'} de {MESES[pm - 1]} ({brl(ant['totalOutflow'])})."
    msg1 = f"{titulo}\n{colunas(resumo, 12)}{comp}"

    # entradas x saídas em barras lado a lado
    fluxo = tabela_barras([("Entradas", entra), ("Saídas", sai)], total=max(entra, sai) or 1, nome=9)
    cats = [(c["name"], float(c["value"])) for c in (d.get("expensesByCategory") or [])[:8]]
    msg2 = "<b>Entradas × saídas</b>\n" + fluxo
    if cats:
        msg2 += "\n<b>Para onde foi</b>\n" + tabela_barras(cats, total=sai or None)

    partes = []
    formas = [(FORMAS.get(x["name"], x["name"]), float(x["value"])) for x in d.get("expensesByPaymentMethod") or []]
    if formas:
        partes.append("<b>Como pagou</b>\n" + tabela_barras(formas, nome=10))
    faturas = [(x["name"], float(x["value"])) for x in d.get("invoicesByCard") or [] if float(x.get("value") or 0)]
    if faturas:
        partes.append("<b>Faturas do mês</b>\n" + colunas([(n, brl(v)) for n, v in faturas]))
    orc = [b for b in d.get("budgets") or [] if float(b.get("limit") or 0) > 0]
    if orc:
        linhas = []
        for b in orc[:8]:
            pct = float(b.get("pct") or 0)
            marca = "🔴" if pct >= 100 else "🟡" if pct >= 80 else "🟢"
            linhas.append(f"{marca} {e(b['category'][:12]).ljust(12)} {barra(min(pct, 100), 100, 10)} {round(pct):>3}%")
        partes.append("<b>Orçamento</b>\n<pre>" + "\n".join(linhas) + "</pre>")
    metas = d.get("goals") or []
    if metas:
        linhas = []
        for g in metas[:6]:
            alvo = float(g.get("targetAmount") or 0)
            pct = float(g.get("savedAmount") or 0) / alvo * 100 if alvo else 0
            linhas.append(f"{e(g['name'][:12]).ljust(12)} {barra(pct, 100, 10)} {round(pct):>3}%")
        partes.append("<b>Metas</b>\n<pre>" + "\n".join(linhas) + "</pre>")
    maiores = sorted(gastos, key=lambda g: -(g.get("amount") or 0))[:6]
    if maiores:
        partes.append("<b>Maiores gastos</b>\n<pre>" + "\n".join(
            f"{e((g.get('date') or '')[8:10] + '/' + (g.get('date') or '')[5:7])} {e((g.get('description') or '')[:16]).ljust(16)} {curto(g.get('amount')):>7}"
            for g in maiores) + "</pre>")
    msgs = [msg1, msg2]
    if partes:
        msgs.append("\n".join(partes))
    return msgs


# ---------------------------------------------------------------- cartões como texto


def cartao(card: dict[str, Any]) -> str | None:
    """O cartão que a ferramenta mostraria na tela, como texto (ou None quando não acrescenta nada)."""
    k, d = card.get("kind"), card.get("data") or {}
    if k == "financeiro":
        if d.get("modo") == "lista" or d.get("linhas"):
            linhas = d.get("linhas") or []
            topo = f"<b>{e(d.get('titulo', ''))}</b>" + (f"\n{brl(d['valor'])}" if isinstance(d.get("valor"), (int, float)) else "")
            corpo = "\n".join(
                f"{'🔴 ' if l.get('tom') == 'perigo' else '🟡 ' if l.get('tom') == 'aviso' else '• '}{e(l.get('rotulo', ''))}"
                + (f" — <b>{e(l.get('valor', ''))}</b>" if l.get("valor") not in (None, "") else "")
                + (f" <i>{e(l.get('detalhe'))}</i>" if l.get("detalhe") else "")
                for l in linhas[:15])
            barras = d.get("barras") or []
            if barras:
                corpo += "\n" + tabela_barras([(b.get("rotulo", ""), float(b.get("valor") or 0)) for b in barras[:8]])
            return f"{topo}\n{corpo}".strip()
        valor = d.get("valor")
        detalhes = [(x.get("rotulo", ""), str(x.get("valor", ""))) for x in d.get("detalhes") or []]
        txt = f"<b>{e(d.get('titulo', 'Lançamento'))}</b>"
        if isinstance(valor, (int, float)):
            txt += f"\n<b>{brl(valor if d.get('sinal') != 'saida' else -abs(valor), sinal=d.get('sinal') == 'entrada')}</b>"
        if detalhes:
            txt += "\n" + colunas(detalhes[:8])
        return txt
    if k == "lista":
        itens = d.get("itens") or []
        return f"<b>{e(d.get('titulo', ''))}</b>\n" + "\n".join(
            f"• <b>{e(i.get('titulo', ''))}</b>" + (f" — {e(i.get('detalhe') or i.get('texto') or '')}" if (i.get("detalhe") or i.get("texto")) else "")
            for i in itens[:12])
    if k == "pesquisa":
        fontes = d.get("fontes") or d.get("itens") or []
        return "\n".join(f"• <a href=\"{e(f.get('url', ''))}\">{e(f.get('titulo', 'fonte'))}</a>" for f in fontes[:5] if f.get("url")) or None
    if k == "clima":
        return (f"🌤 <b>{e(d.get('cidade', ''))}</b> · {e(d.get('condicao', ''))}\n"
                f"<pre>Agora     {d.get('temp', '')}°\nMín/máx   {d.get('min', '')}° / {d.get('max', '')}°\nChuva     {d.get('chuva', 0)}%</pre>")
    if k == "mercado":
        ativos = d.get("ativos") or []
        return "<b>Mercado</b>\n<pre>" + "\n".join(
            f"{e(a.get('simbolo', ''))[:8].ljust(8)} {e(a.get('preco_texto') or a.get('preco') or ''):>12} {'▲' if (a.get('variacao') or 0) >= 0 else '▼'}{abs(float(a.get('variacao') or 0)):.1f}%"
            for a in ativos[:10]) + "</pre>"
    return None
