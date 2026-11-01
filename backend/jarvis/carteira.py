"""Carteira das contas só Telegram (sem computador): o financeiro da pessoa guardado na portaria, leve.

Quem não tem o Jarvis num computador (ex.: um notebook fraco) usa o Telegram com este financeiro simples: contas,
cartões, gastos e entradas, transferências, metas e investimentos. Um arquivo por conta (DADOS/bolso/<perfil>/
carteira.bin, cifrado como o resto do Jarvis de bolso), lido e escrito pelo bolso.py dentro da trava da conta.
Nada de motor do financeiro nem processo à parte: cada mensagem é uma leitura do arquivo e, se registrar algo, uma
escrita.

`copia(pid)` monta os números no mesmo formato da cópia que o Jarvis do computador manda (copia.py), então o
relatório, as consultas e os cartões do Telegram são os mesmos. `aplicar(...)` recebe o mesmo pedido que viraria
pendência (nome da ferramenta do núcleo + argumentos) e grava na hora; `desfazer(id)` tira o que aquele pedido fez.
"""

from __future__ import annotations

import datetime as dt
import secrets
import time
import unicodedata
from typing import Any

from . import textos

CATEGORIAS_GASTO = ["Alimentação", "Mercado", "Transporte", "Moradia", "Contas", "Saúde", "Lazer", "Educação", "Compras",
                    "Assinaturas", "Pets", "Presentes", "Impostos", "Outros"]
CATEGORIAS_ENTRADA = ["Salário", "Freelance", "Vendas", "Presente", "Reembolso", "Rendimentos", "Outros"]
FORMA_CHAVE = {"pix": "PIX", "debito": "DEBITO", "dinheiro": "DINHEIRO", "credito": "CARTAO_CREDITO", "vale": "VALE_BENEFICIO"}


def _bolso():
    from . import bolso

    return bolso


def _arquivo(pid: str):
    return _bolso()._pasta(pid) / "carteira.bin"  # noqa: SLF001


def local(pid: str) -> bool:
    """Conta só Telegram: o financeiro mora aqui (e não num computador)."""
    from . import portaria

    return (portaria.DADOS / "bolso" / pid / "carteira.bin").exists()


def ler(pid: str) -> dict[str, Any]:
    return _bolso()._ler(_arquivo(pid), None) or _vazia()  # noqa: SLF001


def gravar(pid: str, c: dict[str, Any]) -> None:
    _bolso()._gravar(_arquivo(pid), c)  # noqa: SLF001


def _vazia() -> dict[str, Any]:
    return {"versao": 1, "criada": time.time(), "contas": [], "cartoes": [], "lancamentos": [], "transferencias": [],
            "metas": [], "depositos": [], "investimentos": [], "aportes": [], "memorias": []}


def ativar(pid: str, nome: str) -> None:
    """Conta nova só Telegram: carteira vazia e o jeito de chamar a pessoa (o resto ela diz pelo Telegram)."""
    if not local(pid):
        gravar(pid, _vazia())
    _bolso()._gravar(_bolso()._pasta(pid) / "perfil.bin", {"nome": nome, "chamar": nome.split(" ")[0], "cidade": "", "fuso": "America/Sao_Paulo",  # noqa: SLF001
                                                          "modelo": "gemini-3.8-flash", "chat": None})


def perfil(pid: str) -> dict[str, Any]:
    return _bolso()._ler(_bolso()._pasta(pid) / "perfil.bin", {}) or {}  # noqa: SLF001


def mudar_perfil(pid: str, **campos: Any) -> None:
    p = perfil(pid)
    p.update({k: v for k, v in campos.items() if v is not None})
    _bolso()._gravar(_bolso()._pasta(pid) / "perfil.bin", p)  # noqa: SLF001


def _norm(s: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFD", (s or "").lower()) if unicodedata.category(ch) != "Mn").strip()


def _achar(nome: str, itens: list[dict[str, Any]]) -> dict[str, Any] | None:
    n = _norm(nome)
    if not n:
        return None
    return next((i for i in itens if _norm(i["nome"]) == n), None) or next(
        (i for i in itens if n in _norm(i["nome"]) or _norm(i["nome"]) in n), None)


# ---------------------------------------------------------------- saldos e números


def saldos(c: dict[str, Any]) -> dict[str, float]:
    s = {x["nome"]: textos.num(x.get("inicial")) for x in c["contas"]}

    def mexe(conta: str | None, v: float) -> None:
        if conta in s:
            s[conta] += v

    for l in c["lancamentos"]:
        if l["tipo"] == "entrada":
            mexe(l.get("conta"), l["valor"])
        elif l.get("forma") not in ("credito", "vale"):
            mexe(l.get("conta"), -l["valor"])
    for t in c["transferencias"]:
        mexe(t["de"], -t["valor"])
        mexe(t["para"], t["valor"])
    for d in c["depositos"]:
        mexe(d.get("conta"), -d["valor"])  # valor negativo = retirada (volta para a conta)
    for a in c["aportes"]:
        mexe(a.get("conta"), -a["valor"])  # valor negativo = resgate
    return {k: round(v, 2) for k, v in s.items()}


def _meta_guardado(c: dict[str, Any], meta_id: str) -> float:
    return round(sum(d["valor"] for d in c["depositos"] if d["meta"] == meta_id), 2)


def _invest_valor(c: dict[str, Any], inv_id: str) -> float:
    base = next((i for i in c["investimentos"] if i["id"] == inv_id), {}).get("inicial", 0)
    return round(textos.num(base) + sum(a["valor"] for a in c["aportes"] if a["investimento"] == inv_id), 2)


def dados_mes(c: dict[str, Any], mes: str) -> dict[str, Any]:
    """O mesmo formato de textos.dados_mes (o painel do mês do financeiro, enxuto)."""
    do_mes = [l for l in c["lancamentos"] if l["data"][:7] == mes]
    gastos = [l for l in do_mes if l["tipo"] == "gasto"]
    entradas = [l for l in do_mes if l["tipo"] == "entrada"]
    total_g = round(sum(l["valor"] for l in gastos), 2)
    total_e = round(sum(l["valor"] for l in entradas), 2)
    por_cat: dict[str, float] = {}
    por_forma: dict[str, float] = {}
    por_cartao: dict[str, float] = {}
    for l in gastos:
        por_cat[l["categoria"] or "Outros"] = por_cat.get(l["categoria"] or "Outros", 0) + l["valor"]
        f = FORMA_CHAVE.get(l.get("forma") or "pix", "PIX")
        por_forma[f] = por_forma.get(f, 0) + l["valor"]
        if l.get("forma") == "credito" and l.get("cartao"):
            por_cartao[l["cartao"]] = por_cartao.get(l["cartao"], 0) + l["valor"]
    aportado = round(sum(a["valor"] for a in c["aportes"] if a["data"][:7] == mes and a["valor"] > 0), 2)
    s = saldos(c)
    investido = sum(_invest_valor(c, i["id"]) for i in c["investimentos"])
    ant = textos.mes_anterior(mes)
    do_ant = [l for l in c["lancamentos"] if l["data"][:7] == ant]
    d = {
        "totalIncome": total_e, "totalOutflow": total_g, "leftover": round(total_e - total_g, 2),
        "savingRate": round((total_e - total_g) / total_e * 100, 1) if total_e else 0,
        "totalBalance": round(sum(s.values()) + investido, 2), "bankBalance": round(sum(s.values()), 2), "investedBalance": round(investido, 2),
        "contributionTotal": aportado, "openInvoiceTotal": round(sum(por_cartao.values()), 2),
        "expensesByCategory": [{"name": k, "value": round(v, 2)} for k, v in sorted(por_cat.items(), key=lambda kv: -kv[1])],
        "expensesByPaymentMethod": [{"name": k, "value": round(v, 2)} for k, v in por_forma.items()],
        "invoicesByCard": [{"name": k, "value": round(v, 2)} for k, v in por_cartao.items()],
        "budgets": [], "saude": None,
        "goals": [{"name": m["nome"], "targetAmount": m["alvo"], "savedAmount": _meta_guardado(c, m["id"]), "targetDate": m.get("prazo")} for m in c["metas"]],
    }
    item = lambda l: {"descricao": l["descricao"], "categoria": l["categoria"], "valor": l["valor"], "data": l["data"],  # noqa: E731
                      "forma": FORMA_CHAVE.get(l.get("forma") or "", ""), "status": "PAGO", "parcela": ""}
    return {"mes": mes, "d": d,
            "ant": {"totalIncome": sum(l["valor"] for l in do_ant if l["tipo"] == "entrada"),
                    "totalOutflow": sum(l["valor"] for l in do_ant if l["tipo"] == "gasto")} if do_ant else None,
            "gastos": [item(l) for l in gastos], "receitas": [item(l) for l in entradas]}


def copia(pid: str, base: dict[str, Any]) -> dict[str, Any]:
    """A "cópia" que o bolso lê, montada da carteira (meses que têm lançamento + os três últimos)."""
    c = ler(pid)
    hoje = dt.date.today().strftime("%Y-%m")
    meses = {hoje, textos.mes_anterior(hoje), textos.mes_anterior(textos.mes_anterior(hoje))} | {l["data"][:7] for l in c["lancamentos"]}
    s = saldos(c)
    fin = {
        "meses": {m: dados_mes(c, m) for m in meses},
        "contas": [{"nome": x["nome"], "banco": x.get("banco"), "saldo": s.get(x["nome"], 0)} for x in c["contas"]],
        "cartoes": [{"nome": x["nome"], "tipo": x.get("tipo", "CREDITO"), "limite": x.get("limite")} for x in c["cartoes"]],
        "a_pagar": [], "orcamento": [],
        "metas": [{"nome": m["nome"], "alvo": m["alvo"], "guardado": _meta_guardado(c, m["id"]), "prazo": m.get("prazo"), "status": "ATIVA"} for m in c["metas"]],
        "investimentos": {"total": sum(_invest_valor(c, i["id"]) for i in c["investimentos"]),
                          "ativos": [{"nome": i["nome"], "valor": _invest_valor(c, i["id"]), "instituicao": i.get("instituicao")} for i in c["investimentos"]]},
        "categorias": {"gastos": [{"name": n} for n in CATEGORIAS_GASTO], "entradas": [{"name": n} for n in CATEGORIAS_ENTRADA]},
    }
    return {**base, "versao": 1, "gerado": time.time(), "financeiro": fin, "memorias": [{"tipo": "nota", "texto": t} for t in c["memorias"][-400:]],
            "local": True}


# ---------------------------------------------------------------- registrar e desfazer


def cadastrar(pid: str, tipo: str, nome: str, saldo: float = 0, limite: float | None = None, banco: str = "") -> dict[str, Any]:
    c = ler(pid)
    nome = nome.strip()[:40] or ("Conta principal" if tipo == "conta" else "Cartão")
    if tipo == "conta":
        if _achar(nome, c["contas"]):
            return {"erro": f"Já existe a conta {nome}."}
        c["contas"].append({"id": f"k{secrets.token_hex(4)}", "nome": nome, "banco": banco, "inicial": round(saldo, 2)})
    else:
        if _achar(nome, c["cartoes"]):
            return {"erro": f"Já existe o cartão {nome}."}
        c["cartoes"].append({"id": f"r{secrets.token_hex(4)}", "nome": nome, "tipo": "VALE" if tipo == "vale" else "CREDITO", "limite": limite})
    gravar(pid, c)
    return {"ok": True}


def aplicar(pid: str, ident: str, ferramenta: str, a: dict[str, Any]) -> dict[str, Any]:
    """O mesmo pedido que viraria pendência no Jarvis do computador, gravado na hora."""
    c = ler(pid)
    hoje = dt.date.today().isoformat()
    if ferramenta == "financeiro_lancar":
        if not c["contas"]:
            c["contas"].append({"id": f"k{secrets.token_hex(4)}", "nome": "Conta principal", "banco": "", "inicial": 0})
        c["lancamentos"].append({"id": ident, "tipo": a.get("tipo", "gasto"), "valor": round(abs(textos.num(a.get("valor"))), 2),
                                 "descricao": str(a.get("descricao") or "Lançamento")[:120], "categoria": str(a.get("categoria") or "Outros")[:40],
                                 "data": str(a.get("data") or hoje)[:10], "forma": a.get("forma"), "parcelas": a.get("parcelas"),
                                 "conta": a.get("conta") or c["contas"][0]["nome"], "cartao": a.get("cartao")})
    elif ferramenta == "financeiro_transferir":
        c["transferencias"].append({"id": ident, "valor": round(abs(textos.num(a.get("valor"))), 2), "de": a["de"], "para": a["para"],
                                    "data": str(a.get("data") or hoje)[:10]})
    elif ferramenta == "financeiro_meta":
        if a.get("acao") == "criar":
            c["metas"].append({"id": ident, "nome": str(a.get("meta"))[:40], "alvo": round(abs(textos.num(a.get("valor"))), 2), "prazo": a.get("prazo") or None})
        else:
            m = _achar(a.get("meta") or "", c["metas"])
            if not m:
                return {"erro": "Meta não encontrada."}
            v = abs(textos.num(a.get("valor"))) * (1 if a.get("acao") == "guardar" else -1)
            c["depositos"].append({"id": ident, "meta": m["id"], "valor": round(v, 2), "conta": a.get("conta"), "data": hoje})
    elif ferramenta == "financeiro_investir":
        inv = _achar(a.get("investimento") or "", c["investimentos"])
        if not inv:
            inv = {"id": f"i{secrets.token_hex(4)}", "nome": str(a.get("investimento"))[:40], "inicial": 0, "instituicao": ""}
            c["investimentos"].append(inv)
        v = abs(textos.num(a.get("valor"))) * (1 if a.get("acao", "aportar") == "aportar" else -1)
        c["aportes"].append({"id": ident, "investimento": inv["id"], "valor": round(v, 2), "conta": a.get("conta"), "data": str(a.get("data") or hoje)[:10]})
    elif ferramenta == "lembrar":
        c["memorias"].append(str(a.get("texto", ""))[:400])
    else:
        return {"erro": "Isso não está disponível na conta só Telegram."}
    for chave in ("lancamentos", "transferencias", "metas", "depositos", "aportes"):
        for x in c[chave]:
            if x.get("id") == ident:
                x["criado"] = time.time()
    gravar(pid, c)
    return {"ok": True}


def tem(pid: str, ident: str) -> bool:
    c = ler(pid)
    return any(x.get("id") == ident for k in ("lancamentos", "transferencias", "metas", "depositos", "aportes") for x in c[k])


def desfazer(pid: str, ident: str | None = None) -> dict[str, Any] | None:
    """Tira o que o pedido `ident` gravou (sem ident: o último registro). Devolve o que saiu."""
    c = ler(pid)
    chaves = ("lancamentos", "transferencias", "metas", "depositos", "aportes")
    if not ident:
        ultimos = [(x.get("criado", 0), x["id"]) for k in chaves for x in c[k]]
        if not ultimos:
            return None
        ident = max(ultimos)[1]
    for k in chaves:
        alvo = next((x for x in c[k] if x.get("id") == ident), None)
        if alvo:
            c[k].remove(alvo)
            if k == "metas":
                c["depositos"] = [d for d in c["depositos"] if d["meta"] != ident]
            gravar(pid, c)
            return {**alvo, "_k": k}
    return None


def resumo_item(x: dict[str, Any]) -> str:
    if x["_k"] == "lancamentos":
        return f"{x['descricao']} · {textos.brl(x['valor'] if x.get('tipo') == 'entrada' else -x['valor'], sinal=x.get('tipo') == 'entrada')}"
    if x["_k"] == "transferencias":
        return f"Transferência {x['de']} → {x['para']} · {textos.brl(x['valor'])}"
    if x["_k"] == "metas":
        return f"Meta {x['nome']}"
    return textos.brl(abs(x.get("valor", 0)))
