"""Financeiro por voz: o que as ferramentas `financeiro_*` fazem, por cima do motor (finance.py).

A frase dita vai inteira para o leitor da Carteira (entries:parse: valor, data, forma, parcelas, conta/cartão
pelo nome, categoria pelas regras aprendidas); o que a Gemini preencheu em campos separados vale por cima.
Todo lançamento aparece num cartão no HUD com o botão Desfazer.
"""

import datetime as dt
import difflib
import logging
import unicodedata
from typing import Any

from .finance import FinErro, chamar, mudou
from .hub import hub

log = logging.getLogger("jarvis.finance_voz")

FORMAS = {"pix": "PIX", "debito": "DEBITO", "dinheiro": "DINHEIRO", "credito": "CARTAO_CREDITO", "vale": "VALE_BENEFICIO"}
FORMA_NOME = {"PIX": "Pix", "DEBITO": "débito", "DINHEIRO": "dinheiro", "CARTAO_CREDITO": "crédito", "VALE_BENEFICIO": "vale"}
PAGINAS = {"visao_geral": "dashboard", "lancamentos": "transactions", "a_pagar": "payables", "carteira": "wallet",
           "investimentos": "investments", "metas": "goals", "relatorios": "reports", "configuracoes": "settings"}

_ultimos: list[dict[str, str]] = []  # o que a voz lançou nesta sessão (para "desfaz o último")
_importacao: dict[str, Any] | None = None  # extratos lidos esperando o sim


def brl(v: float | int | None) -> str:
    s = f"{float(v or 0):,.2f}"
    return "R$ " + s.replace(",", "X").replace(".", ",").replace("X", ".")


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFD", (s or "").lower())
    return " ".join("".join(c for c in s if unicodedata.category(c) != "Mn").split())


def _achar(nome: str, itens: list[dict], campos=("name", "bankName")) -> dict | None:
    alvo = _norm(nome)
    if not alvo:
        return None
    for it in itens:
        if any(_norm(str(it.get(c, ""))) == alvo for c in campos):
            return it
    for it in itens:
        if any(alvo in _norm(str(it.get(c, ""))) or (_norm(str(it.get(c, ""))) and _norm(str(it.get(c, ""))) in alvo) for c in campos):
            return it
    nomes = {_norm(str(it.get(c, ""))): it for it in itens for c in campos if it.get(c)}
    hit = difflib.get_close_matches(alvo, list(nomes), n=1, cutoff=0.7)
    return nomes[hit[0]] if hit else None


def _data_br(iso: str) -> str:
    try:
        d = dt.date.fromisoformat(iso[:10])
    except ValueError:
        return iso
    hoje = dt.date.today()
    if d == hoje:
        return "hoje"
    if d == hoje - dt.timedelta(days=1):
        return "ontem"
    return d.strftime("%d/%m")


def _ativas(contas: list[dict]) -> list[dict]:
    return [c for c in contas if c.get("status", "ATIVA") in ("ATIVA", "ATIVO")]


async def _cartao(dados: dict[str, Any]) -> dict:
    card = await hub.show_card("financeiro", dados)
    return card


# ---------- lançar ----------


async def lancar(a: dict[str, Any]) -> dict[str, Any]:
    frase = (a.get("frase") or "").strip()
    p: dict[str, Any] = (await chamar("entries:parse", frase) if frase else None) or {}
    if a.get("valor"):
        p["amount"] = float(a["valor"])
    if a.get("tipo") in ("gasto", "entrada"):
        p["isIncome"] = a["tipo"] == "entrada"
    if a.get("forma") in FORMAS:
        p["paymentMethod"] = FORMAS[a["forma"]]
    if a.get("parcelas"):
        p["installments"] = max(1, int(a["parcelas"]))
    if a.get("data"):
        p["date"] = str(a["data"])[:10]
    if a.get("descricao"):
        p["description"] = a["descricao"]
    categoria_dita = (a.get("categoria") or "").strip()
    if categoria_dita:
        p["category"] = categoria_dita
    if not p.get("amount"):
        return {"erro": "Não entendi o valor. Pergunte quanto foi."}

    contas = _ativas(await chamar("accounts:list") or [])
    cartoes = _ativas(await chamar("cards:list") or [])
    if not contas:
        return {"erro": "Ainda não há conta cadastrada no financeiro.", "instrucao": "Ofereça cadastrar a conta principal com financeiro_cadastrar."}
    conta = _achar(a.get("conta") or "", contas) or next((c for c in contas if c["id"] == p.get("accountId")), None) or contas[0]
    cartao = _achar(a.get("cartao") or "", cartoes) or next((c for c in cartoes if c["id"] == p.get("cardId")), None)
    if a.get("cartao") and not _achar(a["cartao"], cartoes):
        return {"erro": f"Não achei o cartão '{a['cartao']}'.", "cartoes": [c["name"] for c in cartoes]}
    if cartao and p.get("paymentMethod") not in ("CARTAO_CREDITO", "VALE_BENEFICIO"):
        p["paymentMethod"] = "CARTAO_CREDITO" if cartao.get("cardType") == "CREDITO" else "VALE_BENEFICIO"
    forma = p.get("paymentMethod") or "PIX"
    data = p.get("date") or dt.date.today().isoformat()
    descricao = (p.get("description") or frase or "Lançamento").strip()[:120]

    if p.get("isIncome"):
        categoria = p.get("category") or "Outros"
        item = await chamar("incomes:create", {"source": descricao, "category": categoria, "bankAccountId": conta["id"],
                                               "amount": p["amount"], "date": data, "description": ""})
        tipo, onde = "income", conta["name"]
        if categoria_dita:
            await chamar("rules:learn", descricao, categoria, "income")
    else:
        credito, vale = forma == "CARTAO_CREDITO", forma == "VALE_BENEFICIO"
        if (credito or vale) and not cartao:
            tipo_card = "CREDITO" if credito else None
            cartao = next((c for c in cartoes if (c.get("cardType") == "CREDITO") == bool(tipo_card)), None)
            if not cartao:
                return {"erro": f"Não há {'cartão de crédito' if credito else 'vale'} cadastrado.",
                        "instrucao": "Ofereça cadastrar com financeiro_cadastrar."}
        categoria = p.get("category") or "Outros"
        parcelas = int(p.get("installments") or 1) if credito else 1
        item = await chamar("expenses:create", {
            "description": descricao, "category": categoria, "paymentMethod": forma,
            "bankAccountId": "" if (credito or vale) else conta["id"], "creditCardId": cartao["id"] if (credito or vale) else "",
            "amount": p["amount"], "date": data, "installments": parcelas, "status": "PENDENTE" if credito else "PAGO"})
        tipo = "expense"
        onde = f"{cartao['name']} · {FORMA_NOME[forma]}{f' {parcelas}x' if parcelas > 1 else ''}" if (credito or vale) else f"{conta['name']} · {FORMA_NOME.get(forma, forma)}"
        if categoria_dita:
            await chamar("rules:learn", descricao, categoria, "variableExpense")

    aviso = None
    if not p.get("isIncome"):
        try:
            fora = await chamar("insights:checkOutlier", descricao, p["amount"], categoria)
            if fora and isinstance(fora, dict):
                aviso = fora.get("message") or fora.get("text") or "; ".join(str(x.get("message", x)) for x in fora.get("flags", []) if x)
        except FinErro:
            pass
    _ultimos.append({"tipo": tipo, "id": item["id"], "descricao": descricao, "valor": p["amount"]})
    del _ultimos[:-20]
    await _cartao({
        "modo": "lancamento", "titulo": descricao, "sinal": "entrada" if tipo == "income" else "saida",
        "valor": p["amount"], "linhas": [
            {"rotulo": "Categoria", "valor": categoria},
            {"rotulo": "Recebido em" if tipo == "income" else "Pago com", "valor": onde},
            {"rotulo": "Data", "valor": _data_br(data)},
        ], "aviso": aviso or None, "desfazer": {"tipo": tipo, "id": item["id"]}})
    await mudou()
    return {"ok": True, "lancado": "entrada" if tipo == "income" else "gasto", "valor": brl(p["amount"]), "categoria": categoria,
            "onde": onde, "data": _data_br(data), "aviso_fora_do_padrao": aviso,
            "instrucao": "Confirme numa frase curta (valor, categoria, onde). Se houver aviso, mencione."}


async def desfazer(tipo: str | None = None, ident: str | None = None) -> dict[str, Any]:
    if not ident:
        if not _ultimos:
            return {"erro": "Não lancei nada por voz nesta sessão."}
        u = _ultimos.pop()
        tipo, ident = u["tipo"], u["id"]
    else:
        _ultimos[:] = [u for u in _ultimos if u["id"] != ident]
    canal = {"expense": "expenses:delete", "income": "incomes:delete", "transfer": "transfers:delete", "deposit": "goals:depositDelete"}.get(tipo or "")
    if not canal:
        return {"erro": "Não sei desfazer esse tipo."}
    await chamar(canal, ident)
    await mudou()
    return {"ok": True, "desfeito": True}


async def transferir(a: dict[str, Any]) -> dict[str, Any]:
    contas = _ativas(await chamar("accounts:list") or [])
    de, para = _achar(a.get("de") or "", contas), _achar(a.get("para") or "", contas)
    if not de or not para:
        return {"erro": "Não achei as duas contas.", "contas": [c["name"] for c in contas]}
    valor = float(a.get("valor") or 0)
    item = await chamar("transfers:create", {"fromAccountId": de["id"], "toAccountId": para["id"], "amount": valor,
                                             "date": (a.get("data") or dt.date.today().isoformat())[:10], "description": a.get("descricao") or ""})
    _ultimos.append({"tipo": "transfer", "id": item["id"], "descricao": "transferência", "valor": valor})
    await _cartao({"modo": "lancamento", "titulo": "Transferência", "sinal": "neutro", "valor": valor,
                   "linhas": [{"rotulo": "De", "valor": de["name"]}, {"rotulo": "Para", "valor": para["name"]}],
                   "desfazer": {"tipo": "transfer", "id": item["id"]}})
    await mudou()
    return {"ok": True, "valor": brl(valor), "de": de["name"], "para": para["name"]}


# ---------- cadastrar contas e cartões ----------


async def cadastrar(a: dict[str, Any]) -> dict[str, Any]:
    nome = (a.get("nome") or "").strip()
    if not nome:
        return {"erro": "Diga o nome (ex.: Inter, Nubank)."}
    if a.get("o_que") == "cartao":
        credito = (a.get("tipo_cartao") or "credito") == "credito"
        if credito and not (a.get("limite") and a.get("dia_fechamento") and a.get("dia_vencimento")):
            return {"erro": "Para cartão de crédito preciso do limite, do dia de fechamento e do dia de vencimento."}
        item = await chamar("cards:create", {"name": nome, "bankName": a.get("banco") or nome, "cardType": "CREDITO" if credito else ("VALE_ALIMENTACAO" if "alim" in _norm(a.get("tipo_cartao") or "") else "VALE_REFEICAO"),
                                             "limit": a.get("limite") or 0, "closingDay": a.get("dia_fechamento") or 0,
                                             "dueDay": a.get("dia_vencimento") or 0, "benefitBalance": a.get("saldo") or 0})
    else:
        item = await chamar("accounts:create", {"name": nome, "bankName": a.get("banco") or nome, "accountType": "CORRENTE",
                                                "initialBalance": a.get("saldo") or 0})
    await mudou()
    return {"ok": True, "cadastrado": item.get("name"), "instrucao": "Confirme numa frase."}


# ---------- consultar ----------


def _mes(a: dict[str, Any]) -> str:
    m = (a.get("mes") or "").strip()
    return m[:7] if len(m) >= 7 else dt.date.today().strftime("%Y-%m")


async def consultar(a: dict[str, Any]) -> dict[str, Any]:
    assunto = a.get("assunto") or "resumo_mes"
    mes = _mes(a)
    ano, num = int(mes[:4]), int(mes[5:7])
    if assunto in ("resumo_mes", "gastos_categoria"):
        d = await chamar("dashboard:get", {"year": ano, "month": num})
        cats = [{"rotulo": c.get("category") or c.get("name"), "valor": c.get("amount") or c.get("total") or c.get("value") or 0}
                for c in (d.get("expensesByCategory") or [])][:8]
        if a.get("categoria"):
            alvo = _norm(a["categoria"])
            achou = [c for c in cats if alvo in _norm(str(c["rotulo"]))]
            total = sum(c["valor"] for c in achou)
            await _cartao({"modo": "resumo", "titulo": f"{a['categoria'].capitalize()} · {mes}", "valor": total, "sinal": "saida",
                           "barras": achou or [{"rotulo": a["categoria"], "valor": 0}]})
            return {"categoria": a["categoria"], "mes": mes, "gasto": brl(total)}
        res = {"entradas": d.get("totalIncome"), "saidas": d.get("totalOutflow"), "sobra": d.get("leftover"),
               "livre_para_gastar": d.get("freeToSpend"), "a_pagar": d.get("payable"), "faturas_abertas": d.get("openInvoiceTotal")}
        await _cartao({"modo": "resumo", "titulo": f"Mês {num:02d}/{ano}", "valor": d.get("leftover"), "sinal": "saldo",
                       "linhas": [{"rotulo": "Entrou", "valor": brl(res["entradas"])}, {"rotulo": "Saiu", "valor": brl(res["saidas"])},
                                  {"rotulo": "Faturas abertas", "valor": brl(res["faturas_abertas"])}],
                       "barras": cats})
        return {k: brl(v) for k, v in res.items()} | {"maiores_categorias": [f"{c['rotulo']}: {brl(c['valor'])}" for c in cats[:5]]}
    if assunto == "saldos":
        contas = _ativas(await chamar("accounts:list") or [])
        total = sum(float(c.get("currentBalance") or 0) for c in contas)
        await _cartao({"modo": "resumo", "titulo": "Saldo nas contas", "valor": total, "sinal": "saldo",
                       "linhas": [{"rotulo": c["name"], "valor": brl(c.get("currentBalance"))} for c in contas]})
        return {"total": brl(total), "contas": {c["name"]: brl(c.get("currentBalance")) for c in contas}}
    if assunto == "a_pagar":
        dias = int(a.get("dias") or 7)
        itens = await chamar("payables:list", dias) or []
        linhas = [{"rotulo": i["title"], "valor": brl(i["amount"]), "detalhe": ("vencida" if i["days"] < 0 else "hoje" if i["days"] == 0 else f"em {i['days']} dias"),
                   "tom": "perigo" if i["days"] <= 0 else "aviso" if i["days"] <= 3 else ""} for i in itens]
        await _cartao({"modo": "lista", "titulo": f"A pagar · {dias} dias", "valor": sum(i["amount"] for i in itens), "sinal": "saida",
                       "linhas": linhas or [{"rotulo": "Nada vencendo", "valor": ""}]})
        return {"itens": [f"{i['title']} {brl(i['amount'])} ({'vencida' if i['days'] < 0 else 'em ' + str(i['days']) + ' dias'})" for i in itens]}
    if assunto == "faturas":
        cartoes = [c for c in await chamar("cards:list") or [] if c.get("cardType") == "CREDITO"]
        linhas, abertas = [], []
        for c in cartoes:
            for f in await chamar("invoices:list", c["id"]) or []:
                if f.get("status") != "PAGA" and float(f.get("total") or f.get("totalAmount") or 0) > 0:
                    v = float(f.get("total") or f.get("totalAmount") or 0)
                    abertas.append(f"{c['name']} {f.get('referenceMonth')}: {brl(v)}, vence {f.get('dueDate')}")
                    linhas.append({"rotulo": f"{c['name']} · {f.get('referenceMonth')}", "valor": brl(v), "detalhe": f"vence {_data_br(f.get('dueDate') or '')}"})
        await _cartao({"modo": "lista", "titulo": "Faturas abertas", "linhas": linhas or [{"rotulo": "Nenhuma fatura aberta", "valor": ""}]})
        return {"faturas_abertas": abertas}
    if assunto == "orcamento":
        ritmo = await chamar("insights:budgetPace", mes) or []
        await _cartao({"modo": "resumo", "titulo": f"Orçamento · {mes}",
                       "barras": [{"rotulo": r["category"], "valor": r["used"], "max": r["limit"]} for r in ritmo]})
        return {"categorias": [f"{r['category']}: {round(r['pct'])}% usado ({brl(r['used'])} de {brl(r['limit'])})"
                               + (", vai estourar no ritmo atual" if r.get("willExceed") else "") for r in ritmo] or "Sem orçamento definido."}
    if assunto == "metas":
        metas = await chamar("goals:list") or []
        await _cartao({"modo": "resumo", "titulo": "Metas",
                       "barras": [{"rotulo": m["name"], "valor": m.get("savedAmount") or 0, "max": m.get("targetAmount") or 0} for m in metas]})
        return {"metas": [f"{m['name']}: {brl(m.get('savedAmount'))} de {brl(m.get('targetAmount'))}" for m in metas]}
    if assunto == "assinaturas":
        subs = await chamar("insights:subscriptions") or {}
        lista = subs.get("items") or subs.get("subscriptions") or (subs if isinstance(subs, list) else [])
        return {"assinaturas": lista[:15]}
    if assunto == "fechamento":
        f = await chamar("insights:monthClosing", mes)
        return {"mes": f.get("label"), "passos": [{"passo": s["title"], "feito": s["done"], "detalhe": s["detail"]} for s in f.get("steps", [])],
                "resumo": {k: (brl(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v) for k, v in (f.get("summary") or {}).items()},
                "instrucao": "Conduza o fechamento por voz, um passo por vez, oferecendo resolver o que falta."}
    if assunto == "proximas_acoes":
        return {"acoes": [f"{x['title']}: {x['detail']}" for x in await chamar("insights:nextActions") or []]}
    return {"erro": f"Assunto desconhecido: {assunto}"}


# ---------- pagar, metas, importar, abrir ----------


async def pagar(a: dict[str, Any]) -> dict[str, Any]:
    contas = _ativas(await chamar("accounts:list") or [])
    conta = _achar(a.get("conta") or "", contas) or (contas[0] if contas else None)
    if not conta:
        return {"erro": "Não há conta cadastrada para pagar."}
    alvo = a.get("o_que") or ""
    cartoes = await chamar("cards:list") or []
    cartao = _achar(alvo.replace("fatura", "").strip(), cartoes)
    if "fatura" in _norm(alvo) or cartao:
        if not cartao:
            return {"erro": "De qual cartão é a fatura?", "cartoes": [c["name"] for c in cartoes]}
        abertas = [f for f in await chamar("invoices:list", cartao["id"]) or [] if f.get("status") != "PAGA" and float(f.get("total") or f.get("totalAmount") or 0) > 0]
        if not abertas:
            return {"erro": f"Não há fatura aberta do {cartao['name']}."}
        fat = sorted(abertas, key=lambda f: f.get("dueDate") or "")[0]
        valor = float(fat.get("total") or fat.get("totalAmount") or 0)
        if not a.get("confirmado"):
            return {"precisa_confirmar": True, "instrucao": f"Pergunte se pode pagar a fatura {fat.get('referenceMonth')} do {cartao['name']} de {brl(valor)} pela conta {conta['name']}."}
        await chamar("invoices:pay", fat["id"], conta["id"])
        await mudou()
        return {"ok": True, "pago": f"fatura {cartao['name']} {fat.get('referenceMonth')}", "valor": brl(valor), "conta": conta["name"]}
    itens = await chamar("payables:list", 60) or []
    hit = _achar(alvo, [i for i in itens if i["kind"] == "expense"], ("title", "category"))
    if not hit:
        return {"erro": f"Não achei '{alvo}' no A pagar.", "a_pagar": [i["title"] for i in itens][:15]}
    if not a.get("confirmado"):
        return {"precisa_confirmar": True, "instrucao": f"Pergunte se pode marcar {hit['title']} ({brl(hit['amount'])}) como pago."}
    await chamar("expenses:markPaid", hit["id"])
    await mudou()
    return {"ok": True, "pago": hit["title"], "valor": brl(hit["amount"])}


async def meta(a: dict[str, Any]) -> dict[str, Any]:
    metas = await chamar("goals:list") or []
    acao = a.get("acao") or "listar"
    if acao == "listar":
        return await consultar({"assunto": "metas"})
    if acao == "criar":
        if not a.get("meta") or not a.get("valor"):
            return {"erro": "Preciso do nome e do valor alvo da meta."}
        item = await chamar("goals:create", {"name": a["meta"], "targetAmount": float(a["valor"]), "targetDate": a.get("prazo") or ""})
        await mudou()
        return {"ok": True, "meta": item["name"], "alvo": brl(item["targetAmount"])}
    m = _achar(a.get("meta") or "", metas, ("name",))
    if not m:
        return {"erro": f"Não achei a meta '{a.get('meta')}'.", "metas": [x["name"] for x in metas]}
    contas = _ativas(await chamar("accounts:list") or [])
    conta = _achar(a.get("conta") or "", contas) or (contas[0] if contas else None)
    valor = abs(float(a.get("valor") or 0)) * (-1 if acao == "retirar" else 1)
    item = await chamar("goals:deposit", m["id"], {"amount": valor, "bankAccountId": conta["id"] if conta else ""})
    _ultimos.append({"tipo": "deposit", "id": item["id"], "descricao": f"meta {m['name']}", "valor": valor})
    atual = await chamar("goals:get", m["id"]) or m
    await _cartao({"modo": "resumo", "titulo": f"Meta · {m['name']}", "valor": abs(valor), "sinal": "saida" if valor > 0 else "entrada",
                   "barras": [{"rotulo": "Guardado", "valor": atual.get("savedAmount") or 0, "max": atual.get("targetAmount") or 0}],
                   "desfazer": {"tipo": "deposit", "id": item["id"]}})
    await mudou()
    return {"ok": True, "meta": m["name"], "guardado_agora": brl(atual.get("savedAmount")), "alvo": brl(atual.get("targetAmount"))}


async def importar(a: dict[str, Any]) -> dict[str, Any]:
    """Lê extratos/faturas (arquivos ou uma pasta), mostra a prévia e só grava com confirmado=true."""
    global _importacao  # noqa: PLW0603
    from . import system

    if a.get("confirmado") and _importacao:
        sessao, alvos = _importacao["sessao"], _importacao["alvos"]
        rel = await chamar("import:commit", sessao, alvos, {})
        _importacao = None
        await mudou()
        return {"ok": True, "importado": rel, "instrucao": "Diga em uma frase quantos lançamentos entraram."}
    caminhos: list[str] = []
    for c in a.get("arquivos") or ([a["pasta"]] if a.get("pasta") else []):
        p = system._resolve(c)  # noqa: SLF001 - mesma regra de pasta pessoal dos arquivos
        if not p:
            continue
        if p.is_dir():
            caminhos += [str(f) for f in sorted(p.iterdir()) if f.suffix.lower() in (".pdf", ".csv", ".ofx", ".txt", ".png", ".jpg", ".jpeg")]
        else:
            caminhos.append(str(p))
    if not caminhos:
        return {"erro": "Não achei extratos ou faturas nesse lugar (PDF, CSV, OFX ou foto)."}
    sessao = await chamar("import:readBatch", caminhos[:40], {})
    alvos = await chamar("import:suggestTargets", sessao)
    _importacao = {"sessao": sessao, "alvos": alvos}
    docs = sessao.get("documents") or []
    resumo = [f"{d.get('fileName')}: {d.get('bank') or 'banco não reconhecido'} · {d.get('documentType') or ''} · {d.get('total') or 0} linhas"
              for d in docs]
    periodo = sessao.get("period") or {}
    await _cartao({"modo": "lista", "titulo": "Importar extratos", "valor": None,
                   "linhas": [{"rotulo": r, "valor": ""} for r in resumo][:10]
                   + [{"rotulo": "Lançamentos novos", "valor": str(sessao.get("selectedCount", 0))},
                      {"rotulo": "Repetidos (ficam de fora)", "valor": str(sessao.get("duplicates", 0))}]})
    return {"arquivos": len(caminhos), "documentos": resumo, "lancamentos_novos": sessao.get("selectedCount"),
            "repetidos": sessao.get("duplicates"), "sem_categoria": sessao.get("uncategorized"),
            "periodo": f"{periodo.get('start')} a {periodo.get('end')}" if periodo else None, "erros": sessao.get("errors"),
            "instrucao": "Conte o que achou e pergunte se pode importar; depois chame de novo com confirmado=true."}


def abrir(pagina: str | None) -> dict[str, Any]:
    hub.app_cmd("financeiro", pagina=PAGINAS.get(pagina or "", "dashboard"))
    return {"ok": True, "instrucao": "Diga numa frase que abriu."}
