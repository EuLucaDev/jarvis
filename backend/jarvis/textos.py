"""Respostas do Telegram em texto diagramado (sem imagens), no visual de um app de banco: título com emoji em
caixa alta, o valor em destaque, campos com emoji e rótulo em negrito, uma linha separando os blocos e barras de
caracteres dentro de blocos monoespaçados (<pre>).

Linguagem de cor (a mesma em todas as mensagens):
  🟢 entradas · 🔴 despesas · 🔵 transferências · 🟣 investimentos · 🎯 metas · ⚠️ pendências e alertas

Usado nos dois Jarvis: o do computador (com o financeiro de verdade) e o de bolso na portaria (com a última cópia).
Nada aqui importa o núcleo: `dados_mes` recebe a função que chama o financeiro.

- `registro(...)`: lançamento, entrada, transferência, investimento, meta (o cartão de "registrado").
- `relatorio_secao(dados, secao)` + `teclado_relatorio(mes, secao)`: o relatório interativo (os botões trocam a
  seção editando a mesma mensagem).
- `cartao(card)`: um cartão que uma ferramenta mostraria na tela, como texto.
"""

from __future__ import annotations

import datetime as dt
import html
import unicodedata
from typing import Any, Awaitable, Callable

MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]
FORMAS = {"PIX": "Pix", "DEBITO": "Débito", "DINHEIRO": "Dinheiro", "CARTAO_CREDITO": "Crédito", "VALE_BENEFICIO": "Vale", "META": "Meta"}
SEP = "───────────────────"
LARGURA = 10  # barras: 10 caracteres = 100%

ESTILO = """visual de app de banco, só texto (nada de imagens), a informação certa na quantidade certa.
- Cores fixas como marcadores: 🟢 entradas · 🔴 despesas · 🔵 transferências · 🟣 investimentos · 🎯 metas ·
  ⚠️ pendências e alertas. Quem lê sabe o assunto antes de ler a mensagem.
- Consulta: título com emoji e em CAIXA ALTA em negrito (ex.: **🍔 GASTOS COM ALIMENTAÇÃO**), o valor principal em
  negrito na linha de baixo, o período, uma linha "───────────────────" e 2 a 4 linhas com emoji + **Rótulo:** valor.
- Conversa e perguntas simples: uma ou duas frases, sem título.
- Comparar números: "gráfico" em bloco ``` com rótulos alinhados, barras █ (cheio) e ░ (vazio), % e valor à direita.
- Análise (quando houver dados para isso): **🧠 ANÁLISE DO JARVIS** e uma ou duas frases com os números de verdade.
- Valores sempre em reais (R$ 1.234,56). Personalidade do J.A.R.V.I.S. em uma frase curta depois de registrar algo
  simples (ex.: "Registrado. Sua moto está levando essa parceria a sério."), nunca no meio de relatório.
- O que as ferramentas mostram já vai como mensagem própria, diagramada: não repita os números, só comente.
- Despesa, transferência e investimento são coisas diferentes: transferir entre contas não é gasto; aplicar não
  reduz o resultado do mês (só o dinheiro da conta).
- Lançamento simples e claro: registra e responde. Faltou o valor, ou parece duplicado: pergunte antes.
- Relatório do mês, fechamento, "me manda o relatório": relatorio_financeiro (ele manda o relatório com botões)."""

COR = {"entrada": "🟢", "saida": "🔴", "transferencia": "🔵", "investimento": "🟣", "meta": "🎯", "alerta": "⚠️"}
_CATEGORIAS = [
    (("aliment", "comida", "restaur", "lanche", "ifood", "padaria"), "🍔"), (("mercado", "supermerc"), "🛒"),
    (("transporte", "uber", "combust", "gasolina", "carro", "moto", "estacion"), "⛽"), (("moradia", "aluguel", "condom", "casa"), "🏠"),
    (("saude", "farmac", "medic", "academia"), "💊"), (("lazer", "viage", "passeio", "cinema"), "🎉"), (("educa", "curso", "escola", "livro"), "📚"),
    (("assinatura", "streaming", "netflix", "spotify"), "📺"), (("compra", "roupa", "vestu"), "🛍️"), (("conta", "luz", "agua", "internet", "telefone", "energia"), "💡"),
    (("pet",), "🐾"), (("salario", "salário"), "💰"), (("freela", "servico", "serviço", "trabalho"), "💼"), (("invest", "aplica"), "📈"),
    (("presente", "doac"), "🎁"), (("imposto", "taxa", "tarifa"), "🧾"),
]


def e(t: Any) -> str:
    return html.escape(str(t if t is not None else ""), quote=False)


def _norm(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", (s or "").lower()) if unicodedata.category(c) != "Mn")


def emoji_categoria(nome: str) -> str:
    n = _norm(nome)
    return next((em for chaves, em in _CATEGORIAS if any(_norm(k) in n for k in chaves)), "🏷️")


def num(v: Any) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def brl(v: Any, sinal: bool = False) -> str:
    n = num(v)
    s = f"{abs(n):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    pre = "– " if n < 0 else ("+ " if sinal and n > 0 else "")
    return f"{pre}R$ {s}"


def curto(v: Any) -> str:
    """R$ sem centavos para colunas estreitas (1.800, 125 mil)."""
    n = abs(num(v))
    if n >= 100000:
        return f"{n / 1000:,.0f} mil".replace(",", ".")
    return f"{n:,.0f}".replace(",", ".")


def pct(parte: Any, total: Any) -> float:
    t = num(total)
    return num(parte) / t * 100 if t else 0.0


def pct_txt(p: float) -> str:
    return f"{p:.1f}".replace(".", ",") + "%" if p < 10 else f"{round(p)}%"


def barra(v: float, maximo: float, largura: int = LARGURA) -> str:
    """Trilho com a parte cheia: ██████░░░░ (a parte vazia mostra o tamanho do todo)."""
    if maximo <= 0:
        return "░" * largura
    cheio = max(0, min(largura, round(v / maximo * largura)))
    if v > 0 and cheio == 0:
        cheio = 1
    return "█" * cheio + "░" * (largura - cheio)


def data_br(iso: str, hoje: dt.date | None = None) -> str:
    try:
        d = dt.date.fromisoformat(str(iso)[:10])
    except ValueError:
        return str(iso or "")
    hoje = hoje or dt.date.today()
    if d == hoje:
        return f"Hoje, {d.strftime('%d/%m/%Y')}"
    if d == hoje - dt.timedelta(days=1):
        return f"Ontem, {d.strftime('%d/%m/%Y')}"
    return d.strftime("%d/%m/%Y")


def rotulo_mes(mes: str) -> str:
    return f"{MESES[int(mes[5:7]) - 1]} de {mes[:4]}"


def _ultimo_dia(mes: str) -> int:
    a, m = int(mes[:4]), int(mes[5:7])
    prox = dt.date(a + (m == 12), m % 12 + 1, 1)
    return (prox - dt.timedelta(days=1)).day


def mes_anterior(mes: str) -> str:
    a, m = int(mes[:4]), int(mes[5:7])
    return f"{a - 1}-12" if m == 1 else f"{a}-{m - 1:02d}"


# ---------------------------------------------------------------- blocos


def titulo(emoji: str, texto: str, sub: str = "") -> str:
    return f"{emoji} <b>{e(texto.upper())}</b>" + (f"\n<i>{e(sub[:1].upper() + sub[1:])}</i>" if sub else "")


def campo(emoji: str, rotulo: str, valor: Any) -> str:
    return f"{emoji} <b>{e(rotulo)}:</b> {e(valor)}"


def linha_valor(emoji: str, rotulo: str, valor: str) -> str:
    return f"{emoji} {e(rotulo)} · <b>{e(valor)}</b>"


def secao(nome: str) -> str:
    return f"<b>{e(nome.upper())}</b>"


def grafico(itens: list[tuple[str, float]], total: float | None = None, nome: int = 11, largura: int = LARGURA) -> str:
    """Linhas "Alimentação ████░░░░░░  38%  1.208" alinhadas num bloco monoespaçado."""
    itens = [(r, v) for r, v in itens if v]
    if not itens:
        return ""
    tot = total if total is not None else sum(v for _, v in itens)
    m = max(v for _, v in itens) if total is None else tot
    linhas = []
    for rotulo, v in itens:
        r = (rotulo[: nome - 1] + "…") if len(rotulo) > nome else rotulo.ljust(nome)
        linhas.append(f"{e(r)} {barra(v, m, largura)} {pct_txt(pct(v, tot)):>4} {curto(v):>6}")
    return "<pre>" + "\n".join(linhas) + "</pre>"


def progresso(feito: float, alvo: float, largura: int = 16) -> str:
    p = pct(feito, alvo)
    return f"<pre>{barra(feito, alvo, largura)} {pct_txt(min(p, 999))}</pre>"


def registro(tipo: str, valor: float, campos: list[tuple[str, str, Any]], rodape: str = "", destaque: str | None = None,
             nota: str = "") -> str:
    """O cartão de "registrado": tipo = despesa, entrada, transferencia, investimento, meta, meta_deposito."""
    cab = {
        "despesa": ("✅", "Despesa registrada", -abs(valor)), "entrada": ("✅", "Entrada registrada", abs(valor)),
        "transferencia": ("🔵", "Transferência registrada", abs(valor)), "investimento": ("🟣", "Investimento registrado", abs(valor)),
        "resgate": ("🟣", "Resgate registrado", abs(valor)), "meta": ("🎯", "Meta criada", abs(valor)),
        "meta_deposito": ("🎯", "Guardado na meta", abs(valor)), "meta_retirada": ("🎯", "Retirado da meta", abs(valor)),
    }.get(tipo, ("✅", "Registrado", valor))
    v = cab[2]
    partes = [titulo(cab[0], cab[1]), f"<b>{brl(v, sinal=tipo == 'entrada')}</b>" if v else ""]
    if destaque:
        partes.append(f"<b>{e(destaque)}</b>")
    corpo = [campo(*c) for c in campos if c[2] not in (None, "")]
    if corpo:
        partes += [SEP, "\n".join(corpo)]
    if rodape:
        partes += [SEP, rodape]
    if nota:
        partes.append(f"<i>{e(nota)}</i>")
    return "\n".join(p for p in partes if p)


# ---------------------------------------------------------------- dados do mês (computador ou cópia)

CHAVES_PAINEL = ("totalBalance", "bankBalance", "investedBalance", "benefitBalance", "totalIncome", "totalOutflow", "bankOutflow",
                 "freeToSpend", "leftover", "savingRate", "openInvoiceTotal", "payable", "contributionTotal", "withdrawalTotal",
                 "counts", "expensesByCategory", "expensesByPaymentMethod", "budgets", "monthlyGoal", "fixedVsVariable")


def enxuto(d: dict[str, Any]) -> dict[str, Any]:
    """Só o que as mensagens usam do painel do financeiro (o painel inteiro é grande)."""
    out = {k: d.get(k) for k in CHAVES_PAINEL if k in d}
    out["invoicesByCard"] = [{"name": x.get("name"), "value": x.get("value")} for x in d.get("invoicesByCard") or []]
    out["goals"] = [{"name": g.get("name"), "targetAmount": g.get("targetAmount"), "savedAmount": g.get("savedAmount"),
                     "targetDate": g.get("targetDate")} for g in d.get("goals") or []]
    saude = (d.get("intelligence") or {}).get("health") or {}
    out["saude"] = {"score": saude.get("score"), "label": saude.get("label")} if saude else None
    return out


def _item(x: dict[str, Any], entrada: bool) -> dict[str, Any]:
    return {"descricao": (x.get("source") if entrada else x.get("description")) or x.get("description") or "",
            "categoria": x.get("category") or "", "valor": num(x.get("amount")), "data": str(x.get("date") or "")[:10],
            "forma": x.get("paymentMethod") or "", "status": x.get("status") or "", "parcela": x.get("installmentLabel") or ""}


async def dados_mes(chamar: Callable[..., Awaitable[Any]], mes: str) -> dict[str, Any]:
    """O que o relatório e as consultas usam de um mês: painel enxuto, o mês anterior, gastos e entradas."""
    ano, m = int(mes[:4]), int(mes[5:7])
    d = await chamar("dashboard:get", {"year": ano, "month": m}) or {}
    pa = mes_anterior(mes)
    try:
        ant = await chamar("dashboard:get", {"year": int(pa[:4]), "month": int(pa[5:7])}) or {}
    except Exception:  # noqa: BLE001
        ant = {}
    gastos = await chamar("expenses:list", {"year": ano, "month": m}) or []
    receitas = await chamar("incomes:list", {"year": ano, "month": m}) or []
    if isinstance(gastos, dict):
        gastos = gastos.get("items") or []
    if isinstance(receitas, dict):
        receitas = receitas.get("items") or []
    gastos = [x for x in gastos if str(x.get("date") or "")[:7] == mes]
    receitas = [x for x in receitas if str(x.get("date") or "")[:7] == mes]
    return {"mes": mes, "d": enxuto(d), "ant": {"totalIncome": ant.get("totalIncome"), "totalOutflow": ant.get("totalOutflow")} if ant else None,
            "gastos": [_item(x, False) for x in gastos], "receitas": [_item(x, True) for x in receitas]}


# ---------------------------------------------------------------- relatório interativo

SECOES = [("resumo", "📊 Resumo"), ("despesas", "🔴 Despesas"), ("receitas", "🟢 Receitas"), ("metas", "🎯 Metas")]


def teclado_relatorio(mes: str, ativa: str = "resumo") -> dict[str, Any]:
    botoes = [{"text": ("• " + r + " •") if s == ativa else r, "callback_data": f"r:{s}:{mes}"} for s, r in SECOES]
    ant = mes_anterior(mes)
    return {"inline_keyboard": [botoes[:2], botoes[2:], [{"text": f"◀ {MESES[int(ant[5:7]) - 1].capitalize()}", "callback_data": f"r:{ativa}:{ant}"}]]}


def analise(dados: dict[str, Any]) -> str:
    """Leitura do mês feita só com os números do financeiro (nada inventado)."""
    d = dados.get("d") or {}
    entra, sai = num(d.get("totalIncome")), num(d.get("totalOutflow"))
    cats = d.get("expensesByCategory") or []
    frases = []
    if not entra and not sai:
        return "Ainda não há lançamentos neste mês."
    if entra:
        frases.append(f"Você gastou {pct_txt(pct(sai, entra))} do que entrou" + (" e fechou no vermelho." if sai > entra else "."))
    if cats:
        top = cats[0]
        frases.append(f"{top['name']} foi a maior categoria, com {pct_txt(pct(top['value'], sum(num(c['value']) for c in cats)))} das despesas.")
    ant = dados.get("ant") or {}
    if num(ant.get("totalOutflow")) and sai:
        var = (sai - num(ant["totalOutflow"])) / num(ant["totalOutflow"]) * 100
        if abs(var) >= 3:
            frases.append(f"As saídas {'subiram' if var > 0 else 'caíram'} {pct_txt(abs(var))} em relação a {MESES[int(mes_anterior(dados['mes'])[5:7]) - 1]}.")
    estouro = [b for b in d.get("budgets") or [] if num(b.get("limit")) and num(b.get("used")) > num(b.get("limit"))]
    if estouro:
        frases.append(f"⚠️ Orçamento estourado em {', '.join(b['category'] for b in estouro[:3])}.")
    return " ".join(frases)


def relatorio_secao(dados: dict[str, Any], secao_nome: str = "resumo", nota: str = "") -> str:
    mes = dados["mes"]
    d = dados.get("d") or {}
    hoje = dt.date.today()
    fim = min(_ultimo_dia(mes), hoje.day) if mes == hoje.strftime("%Y-%m") else _ultimo_dia(mes)
    periodo = f"01 a {fim:02d} de {rotulo_mes(mes)}"
    entra, sai = num(d.get("totalIncome")), num(d.get("totalOutflow"))
    partes: list[str]
    if secao_nome == "despesas":
        cats = [(c["name"], num(c["value"])) for c in d.get("expensesByCategory") or []]
        partes = [titulo("🔴", "Despesas", periodo), f"<b>{brl(-sai)}</b>"]
        if cats:
            partes += [SEP, secao("Por categoria"), grafico(cats[:8], total=sum(v for _, v in cats))]
        formas = [(FORMAS.get(x["name"], x["name"]), num(x["value"])) for x in d.get("expensesByPaymentMethod") or []]
        if formas:
            partes += [secao("Como pagou"), grafico(formas)]
        maiores = sorted(dados.get("gastos") or [], key=lambda g: -g["valor"])[:6]
        if maiores:
            partes += [secao("Maiores gastos"), "\n".join(
                f"{emoji_categoria(g['categoria'])} {e(g['descricao'][:28])} · <b>{brl(g['valor'])}</b> <i>{g['data'][8:10]}/{g['data'][5:7]}</i>" for g in maiores)]
        faturas = [(x["name"], num(x["value"])) for x in d.get("invoicesByCard") or [] if num(x.get("value"))]
        if faturas:
            partes += [SEP, secao("Faturas abertas"), "\n".join(linha_valor("💳", n, brl(v)) for n, v in faturas)]
    elif secao_nome == "receitas":
        rec = dados.get("receitas") or []
        partes = [titulo("🟢", "Receitas", periodo), f"<b>{brl(entra)}</b>"]
        por: dict[str, float] = {}
        for r in rec:
            por[r["categoria"] or "Outros"] = por.get(r["categoria"] or "Outros", 0) + r["valor"]
        if por:
            partes += [SEP, secao("Por categoria"), grafico(sorted(por.items(), key=lambda kv: -kv[1])[:8], total=sum(por.values()))]
        if rec:
            partes += [secao("Entradas do mês"), "\n".join(
                f"{emoji_categoria(r['categoria'])} {e(r['descricao'][:28])} · <b>{brl(r['valor'])}</b> <i>{r['data'][8:10]}/{r['data'][5:7]}</i>"
                for r in sorted(rec, key=lambda r: r["data"], reverse=True)[:8])]
        else:
            partes += [SEP, "Nenhuma entrada lançada neste mês."]
    elif secao_nome == "metas":
        metas = d.get("goals") or []
        partes = [titulo("🎯", "Metas e orçamento", rotulo_mes(mes))]
        if metas:
            for g in metas:
                alvo = num(g.get("targetAmount"))
                partes += [SEP, f"<b>{e(g['name'])}</b>", f"{brl(g.get('savedAmount'))} de {brl(alvo)}", progresso(num(g.get("savedAmount")), alvo)]
        else:
            partes += [SEP, "Nenhuma meta ativa. Diga “cria uma meta de 10 mil para a viagem”."]
        orc = [b for b in d.get("budgets") or [] if num(b.get("limit")) > 0]
        if orc:
            linhas = []
            for b in orc[:8]:
                p = pct(b.get("used"), b.get("limit"))
                marca = "🔴" if p >= 100 else "🟡" if p >= 80 else "🟢"
                linhas.append(f"{marca} {e(b['category'][:11]).ljust(11)} {barra(min(p, 100), 100)} {round(p):>3}%")
            partes += [SEP, secao("Orçamento do mês"), "<pre>" + "\n".join(linhas) + "</pre>"]
    else:
        resultado = entra - sai
        partes = [titulo("📊", "Relatório financeiro", periodo), SEP, secao("Visão geral"),
                  linha_valor("🟢", "Receitas", brl(entra)), linha_valor("🔴", "Despesas", brl(sai)),
                  linha_valor("💰", "Resultado do mês", brl(resultado, sinal=True))]
        if num(d.get("contributionTotal")):
            partes.append(linha_valor("🟣", "Investido no mês", brl(d["contributionTotal"])))
        if num(d.get("openInvoiceTotal")):
            partes.append(linha_valor("💳", "Faturas abertas", brl(d["openInvoiceTotal"])))
        partes.append(linha_valor("🏦", "Saldo total", brl(d.get("totalBalance"))))
        cats = [(c["name"], num(c["value"])) for c in d.get("expensesByCategory") or []]
        if cats:
            principais = cats[:4]
            resto = sum(v for _, v in cats[4:])
            if resto:
                principais.append(("Outros", resto))
            partes += [SEP, secao("Despesas por categoria"), grafico(principais, total=sum(v for _, v in cats))]
        saude = d.get("saude") or {}
        partes += [SEP, "🧠 <b>ANÁLISE DO JARVIS</b>", e(analise(dados))]
        if saude.get("score") is not None:
            partes.append(f"<i>Saúde financeira: {saude['score']} · {e(saude.get('label') or '')}</i>")
    if nota:
        partes.append(f"<i>{e(nota)}</i>")
    return "\n".join(p for p in partes if p)


async def relatorio(mes: str, nome: str = "") -> list[dict[str, Any]]:
    """O relatório do mês (computador): a mensagem do resumo com os botões das outras seções."""
    from . import finance

    dados = await dados_mes(finance.chamar, mes)
    return [{"texto": relatorio_secao(dados, "resumo"), "teclado": teclado_relatorio(mes, "resumo")}]


# ---------------------------------------------------------------- cartões como texto

_ROTULO_EMOJI = {"pago com": "💳", "recebido em": "🏦", "data": "📅", "de": "↗️", "para": "↘️", "conta": "🏦", "cartão": "💳",
                 "saldo após lançamento": "💰", "parcelas": "🧾"}


def cartao(card: dict[str, Any]) -> str | None:
    """O cartão que a ferramenta mostraria na tela, como texto (ou None quando não acrescenta nada)."""
    k, d = card.get("kind"), card.get("data") or {}
    if k == "financeiro":
        if d.get("modo") == "lancamento":
            sinal = d.get("sinal")
            tipo = "entrada" if sinal == "entrada" else "transferencia" if sinal == "neutro" else "despesa"
            campos: list[tuple[str, str, Any]] = []
            rodape = ""
            hoje = dt.date.today()
            for ln in d.get("linhas") or []:
                rot, val = str(ln.get("rotulo", "")), ln.get("valor")
                if rot.lower().startswith("saldo"):
                    rodape = f"💰 {e(rot)}: <b>{e(val)}</b>"
                    continue
                if rot.lower() == "data" and str(val).lower() in ("hoje", "ontem"):
                    val = data_br((hoje - dt.timedelta(days=str(val).lower() == "ontem")).isoformat(), hoje)
                em = emoji_categoria(str(val)) if rot.lower() == "categoria" else _ROTULO_EMOJI.get(rot.lower(), "•")
                campos.append((em, rot, val))
                if rot.lower() == "categoria" and tipo != "transferencia":
                    campos.append(("📝", "Descrição", d.get("titulo")))
            if tipo != "transferencia" and not any(c[1] == "Descrição" for c in campos):
                campos.insert(0, ("📝", "Descrição", d.get("titulo")))
            nota = "Registrado no seu financeiro."
            if d.get("aviso"):
                rodape = (rodape + "\n" if rodape else "") + f"⚠️ {e(d['aviso'])}"
            return registro(tipo, num(d.get("valor")), campos, rodape=rodape, nota=nota)
        topo = titulo("📊", d.get("titulo") or "Financeiro")
        partes = [topo]
        if isinstance(d.get("valor"), (int, float)):
            partes.append(f"<b>{brl(d['valor'])}</b>")
        linhas = d.get("linhas") or []
        if linhas:
            partes.append(SEP)
            partes.append("\n".join(
                f"{'🔴 ' if l.get('tom') == 'perigo' else '🟡 ' if l.get('tom') == 'aviso' else '• '}{e(l.get('rotulo', ''))}"
                + (f" · <b>{e(l.get('valor', ''))}</b>" if l.get("valor") not in (None, "") else "")
                + (f" <i>{e(l.get('detalhe'))}</i>" if l.get("detalhe") else "")
                for l in linhas[:15]))
        barras = d.get("barras") or []
        if barras:
            com_max = [b for b in barras if num(b.get("max"))]
            if com_max:
                partes.append(SEP)
                for b in com_max[:8]:
                    partes += [f"<b>{e(b.get('rotulo', ''))}</b> · {brl(b.get('valor'))} de {brl(b.get('max'))}", progresso(num(b.get("valor")), num(b.get("max")))]
            else:
                partes += [SEP, grafico([(str(b.get("rotulo", "")), num(b.get("valor"))) for b in barras[:8]])]
        return "\n".join(p for p in partes if p)
    if k == "lista":
        itens = d.get("itens") or []
        return f"📋 <b>{e((d.get('titulo') or '').upper())}</b>\n{SEP}\n" + "\n".join(
            f"• <b>{e(i.get('titulo', ''))}</b>" + (f" · {e(i.get('detalhe') or i.get('texto') or '')}" if (i.get("detalhe") or i.get("texto")) else "")
            for i in itens[:12])
    if k == "pesquisa":
        fontes = d.get("fontes") or d.get("itens") or []
        links = [f"🔗 <a href=\"{e(f.get('url', ''))}\">{e(f.get('titulo', 'fonte'))}</a>" for f in fontes[:5] if f.get("url")]
        return ("🔎 <b>FONTES</b>\n" + "\n".join(links)) if links else None
    if k == "clima":
        return (f"🌤 <b>{e((d.get('cidade') or '').upper())}</b>\n<i>{e(d.get('condicao', ''))}</i>\n<b>{d.get('temp', '')}°</b>\n{SEP}\n"
                f"🌡 <b>Mín/máx:</b> {d.get('min', '')}° / {d.get('max', '')}°\n☔ <b>Chuva:</b> {d.get('chuva', 0)}%")
    if k == "mercado":
        ativos = d.get("ativos") or []
        return "📈 <b>MERCADO</b>\n" + SEP + "\n" + "\n".join(
            f"{'🟢' if num(a.get('variacao')) >= 0 else '🔴'} {e(a.get('simbolo', ''))} · <b>{e(a.get('preco_texto') or a.get('preco') or '')}</b> "
            f"<i>{'+' if num(a.get('variacao')) >= 0 else '–'}{abs(num(a.get('variacao'))):.1f}%</i>" for a in ativos[:10])
    return None
