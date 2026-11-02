"""Carteira das contas só Telegram (sem computador): o financeiro da pessoa guardado na portaria, leve.

Quem não tem o Jarvis num computador (ex.: um notebook fraco) usa o Telegram com este financeiro simples: contas,
cartões, gastos e entradas, transferências, metas e investimentos. Um arquivo por conta (DADOS/bolso/<perfil>/
carteira.bin, cifrado como o resto do Jarvis de bolso), lido e escrito pelo bolso.py dentro da trava da conta.
Nada de motor do financeiro nem processo à parte: cada mensagem é uma leitura do arquivo e, se registrar algo, uma
escrita.

`copia(pid)` monta os números no mesmo formato da cópia que o Jarvis do computador manda (copia.py), então o
relatório, as consultas e os cartões do Telegram são os mesmos. `aplicar(...)` recebe o mesmo pedido que viraria
pendência (nome da ferramenta do núcleo + argumentos) e grava na hora; `desfazer(id)` tira o que aquele pedido fez.

Investimentos aqui são por valor (sem cotação automática): o que foi aplicado e resgatado, proventos (que ficam no
investimento ou vão para a conta) e o valor atual que a pessoa lê no app do banco (`avaliacoes`). `relatorio_investimentos`
devolve o mesmo formato de investimentos.compactar (do computador), com as lacunas desta modalidade.
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
    c = _bolso()._ler(_arquivo(pid), None) or _vazia()  # noqa: SLF001
    for k in ("proventos", "avaliacoes"):  # carteiras criadas antes dos investimentos completos
        c.setdefault(k, [])
    return c


def gravar(pid: str, c: dict[str, Any]) -> None:
    _bolso()._gravar(_arquivo(pid), c)  # noqa: SLF001


def _vazia() -> dict[str, Any]:
    return {"versao": 1, "criada": time.time(), "contas": [], "cartoes": [], "lancamentos": [], "transferencias": [],
            "metas": [], "depositos": [], "investimentos": [], "aportes": [], "proventos": [], "avaliacoes": [], "memorias": []}


CHAVES = ("lancamentos", "transferencias", "metas", "depositos", "aportes", "proventos", "avaliacoes")


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
        if not a.get("interno"):
            mexe(a.get("conta"), -a["valor"])  # valor negativo = resgate
    for pr in c["proventos"]:
        if pr.get("destino") == "conta":
            mexe(pr.get("conta"), pr["valor"])
    return {k: round(v, 2) for k, v in s.items()}


def _meta_guardado(c: dict[str, Any], meta_id: str) -> float:
    return round(sum(d["valor"] for d in c["depositos"] if d["meta"] == meta_id), 2)


def _depois(x: dict[str, Any], ref: dict[str, Any] | None) -> bool:
    return ref is None or (x["data"], x.get("criado", 0)) > (ref["data"], ref.get("criado", 0))


def _posicao(c: dict[str, Any], inv: dict[str, Any]) -> dict[str, Any]:
    """Valor de um investimento por valor: o último valor informado + o que entrou/saiu depois dele."""
    meus = [a for a in c["aportes"] if a["investimento"] == inv["id"] and not a.get("interno")]
    provs = [p for p in c["proventos"] if p["investimento"] == inv["id"]]
    aval = max((v for v in c["avaliacoes"] if v["investimento"] == inv["id"]), key=lambda v: (v["data"], v.get("criado", 0)), default=None)
    base = aval["valor"] if aval else textos.num(inv.get("inicial"))
    valor = base + sum(a["valor"] for a in meus if _depois(a, aval)) + sum(p["valor"] for p in provs if p.get("destino") == "caixa" and _depois(p, aval))
    return {"valor": round(max(0.0, valor), 2), "aplicado": round(textos.num(inv.get("inicial")) + sum(a["valor"] for a in meus), 2),
            "proventos": round(sum(p["valor"] for p in provs), 2), "proventos_conta": round(sum(p["valor"] for p in provs if p.get("destino") == "conta"), 2),
            "avaliado_em": aval["data"] if aval else None}


def _invest_valor(c: dict[str, Any], inv_id: str) -> float:
    inv = next((i for i in c["investimentos"] if i["id"] == inv_id), None)
    return _posicao(c, inv)["valor"] if inv else 0.0


def relatorio_investimentos(c: dict[str, Any], hoje: dt.date | None = None) -> dict[str, Any]:
    """A carteira desta conta no formato de investimentos.compactar (mesmo visual e mesmas grandezas)."""
    from . import mentor

    hoje = hoje or dt.date.today()
    lacunas: list[dict[str, Any]] = []
    ativos, grupos = [], {}
    patrimonio = aplicado = proventos_conta = 0.0
    sem_aval, aval_antiga = [], []
    for inv in c["investimentos"]:
        p = _posicao(c, inv)
        g = mentor.grupo(inv.get("classe"))
        patrimonio += p["valor"]
        aplicado += p["aplicado"]
        proventos_conta += p["proventos_conta"]
        grupos[g] = grupos.get(g, 0.0) + p["valor"]
        if not p["avaliado_em"]:
            sem_aval.append(inv["nome"])
        elif (hoje - dt.date.fromisoformat(p["avaliado_em"])).days > 35:
            aval_antiga.append(f"{inv['nome']} ({textos.data_br(p['avaliado_em'], hoje)})")
        ativos.append({"ativo": inv["nome"], "classe": inv.get("classe"), "grupo": g, "instituicao": inv.get("instituicao"), "valor": p["valor"],
                       "custo": p["aplicado"], "proventos": p["proventos"],
                       "avaliacao": f"valor informado em {textos.data_br(p['avaliado_em'], hoje)}" if p["avaliado_em"] else "pelo valor aplicado (sem valor atual informado)"})
    flows = [(a["data"], a["valor"]) for a in c["aportes"] if not a.get("interno")]
    flows += [(p["data"], -p["valor"]) for p in c["proventos"] if p.get("destino") == "conta"]
    iniciais = [i for i in c["investimentos"] if textos.num(i.get("inicial"))]
    entrou = sum(v for _, v in flows if v > 0) + sum(textos.num(i.get("inicial")) for i in iniciais)
    saiu = -sum(v for _, v in flows if v < 0)
    resultado = round(patrimonio - aplicado + proventos_conta, 2)
    janela = lambda desde: round(sum(v for d, v in flows if d >= desde), 2)  # noqa: E731
    provs = c["proventos"]
    if sem_aval:
        lacunas.append({"codigo": "sem_valor_atual", "texto": "Sem valor atual informado: entram pelo valor aplicado (o resultado delas aparece como zero)", "itens": sem_aval[:8]})
    if aval_antiga:
        lacunas.append({"codigo": "valor_antigo", "texto": "Valor atual informado há mais de um mês", "itens": aval_antiga[:8]})
    if iniciais:
        lacunas.append({"codigo": "sem_historico", "texto": "Saldo inicial sem data de aplicação", "itens": [i["nome"] for i in iniciais][:8]})
    lacunas.append({"codigo": "sem_cotacao", "texto": "Conta só Telegram: sem cotação automática nem pesquisa; o valor vem do que você informa", "itens": []})
    xirr = {"metodo": "XIRR (taxa interna dos aportes e retiradas datados)", "no_periodo_pct": None, "ao_ano_pct": None, "dias": 0, "motivo_sem_taxa": None}
    if not flows:
        xirr["motivo_sem_taxa"] = "Ainda não há aportes registrados."
    elif sem_aval or iniciais:
        xirr["motivo_sem_taxa"] = "Falta o valor atual (ou a data dos aportes) de algum investimento: a taxa seria inventada."
    else:
        r = mentor.xirr([(d, -v) for d, v in flows] + [(hoje.isoformat(), patrimonio)])
        dias = (hoje - min(dt.date.fromisoformat(d) for d, _ in flows)).days
        xirr["dias"] = dias
        if r is None or dias < 30:
            xirr["motivo_sem_taxa"] = "Menos de 30 dias de histórico." if r is not None else "Os fluxos não permitem calcular uma taxa."
        else:
            xirr["no_periodo_pct"] = round(((1 + r) ** (dias / 365) - 1) * 100, 2)
            xirr["ao_ano_pct"] = round(r * 100, 2) if dias >= 365 else None
    reserva = grupos.pop("reserva", 0.0)
    investivel = patrimonio - reserva
    return {
        "gerado_em": dt.datetime.now().isoformat(timespec="seconds"), "data": hoje.isoformat(),
        "perimetro": "Investimentos registrados aqui (por valor). Saldo de conta não entra.",
        "patrimonio": round(patrimonio, 2), "posicoes": round(patrimonio, 2), "caixa_da_carteira": 0.0, "reserva": round(reserva, 2),
        "do_seu_bolso": {"liquido": round(entrou - saiu, 2), "entrou": round(entrou, 2), "saiu": round(saiu, 2),
                         "no_mes": janela(hoje.strftime("%Y-%m-01")), "no_ano": janela(hoje.strftime("%Y-01-01")),
                         "em_12_meses": janela((hoje - dt.timedelta(days=365)).isoformat()), "saldo_sem_historico": round(sum(textos.num(i.get("inicial")) for i in iniciais), 2)},
        "resultado": {"total": resultado, "nao_realizado": None, "realizado": None, "proventos": round(sum(p["valor"] for p in provs), 2),
                      "custos_pagos": None, "formula": "valor atual − aplicado + proventos que foram para a conta"},
        "proventos": {"recebidos_mes": round(sum(p["valor"] for p in provs if p["data"] >= hoje.strftime("%Y-%m-01")), 2),
                      "recebidos_ano": round(sum(p["valor"] for p in provs if p["data"] >= hoje.strftime("%Y-01-01")), 2),
                      "recebidos_12m": round(sum(p["valor"] for p in provs if p["data"] >= (hoje - dt.timedelta(days=365)).isoformat()), 2),
                      "recebidos_total": round(sum(p["valor"] for p in provs), 2), "a_receber": None, "a_receber_itens": [], "a_confirmar": 0,
                      "ficaram_no_caixa": round(sum(p["valor"] for p in provs if p.get("destino") == "caixa"), 2), "estimados": None,
                      "nota": "Aqui só entram proventos recebidos que você registra."},
        "rentabilidade": {"xirr": xirr, "twr_aproximado": {"metodo": None, "no_periodo_pct": None, "motivo_sem_taxa": "Sem fotos do patrimônio nesta modalidade."},
                          "benchmark": None, "benchmark_nota": "Sem série comparável guardada."},
        "alocacao": {"denominador": "patrimônio sem a reserva", "tem_politica": False,
                     "grupos": [{"grupo": g, "nome": mentor.NOME_GRUPO[g], "valor": round(v, 2), "pct": round(v / investivel * 100, 2) if investivel > 0 else 0,
                                 "meta_pct": None, "desvio_pp": None, "para_a_meta": None} for g, v in sorted(grupos.items(), key=lambda kv: -kv[1]) if v]},
        "concentracao": {"ativos_acima": [{"ativo": a["ativo"], "pct": round(a["valor"] / investivel * 100, 2)} for a in ativos
                                          if a["grupo"] != "reserva" and investivel > 0 and a["valor"] / investivel * 100 >= 20],
                         "referencia": "referência de 20% (sem limite aprovado)", "instituicoes": []},
        "moedas": [{"moeda": "BRL", "valor": round(patrimonio, 2)}], "liquidez_a_conferir": [],
        "cotacoes": {"mais_recente": None, "cobertura": None},
        "ativos": sorted(ativos, key=lambda a: -a["valor"])[:40], "evolucao": [], "politica": None, "perfil": None,
        "lacunas": lacunas, "eventos_nao_suportados": [],
    }


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
                          "ativos": [{"nome": i["nome"], "valor": _invest_valor(c, i["id"]), "instituicao": i.get("instituicao")} for i in c["investimentos"]],
                          "relatorio": relatorio_investimentos(c)},
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
    elif ferramenta == "investimentos_registrar":
        res = _registrar_investimento(c, ident, a, hoje)
        if res.get("erro"):
            return res
    elif ferramenta == "lembrar":
        c["memorias"].append(str(a.get("texto", ""))[:400])
    else:
        return {"erro": "Isso não está disponível na conta só Telegram."}
    for chave in CHAVES:
        for x in c[chave]:
            if x.get("id") == ident:
                x["criado"] = time.time()
    gravar(pid, c)
    return {"ok": True}


def _registrar_investimento(c: dict[str, Any], ident: str, a: dict[str, Any], hoje: str) -> dict[str, Any]:
    """Operação já feita, por valor: compra/aporte somam, venda/resgate/amortização subtraem; provento e valor atual à parte."""
    from . import mentor

    falta = mentor.faltam_registro(a)
    if falta:
        return {"erro": "Falta " + ", ".join(falta) + "."}
    op = str(a.get("operacao")).lower()
    data = str(a.get("data") or hoje)[:10]
    inv = _achar(a.get("ativo") or "", c["investimentos"])
    if not inv:
        if op not in ("compra", "aporte", "provento", "valor_atual", "bonificacao"):
            return {"erro": f"Não achei o investimento '{a.get('ativo')}' para {op}."}
        inv = {"id": f"i{secrets.token_hex(4)}", "nome": str(a.get("ativo"))[:40], "inicial": 0, "instituicao": str(a.get("instituicao") or "")[:40],
               "classe": str(a.get("classe") or "").upper() or None}
        c["investimentos"].append(inv)
    qtd, preco, taxas = textos.num(a.get("quantidade")), textos.num(a.get("preco")), abs(textos.num(a.get("taxas")))
    valor = abs(textos.num(a.get("valor"))) or (qtd * preco)
    interno = str(a.get("origem") or "").lower().startswith("caixa")
    if op in ("compra", "aporte"):
        c["aportes"].append({"id": ident, "investimento": inv["id"], "valor": round(valor + taxas, 2), "conta": a.get("conta"), "data": data,
                             "operacao": op, "quantidade": qtd or None, "preco": preco or None, "interno": interno})
    elif op in ("venda", "resgate", "amortizacao"):
        c["aportes"].append({"id": ident, "investimento": inv["id"], "valor": -round(max(0.0, valor - taxas), 2), "conta": a.get("conta"), "data": data,
                             "operacao": op, "quantidade": qtd or None, "preco": preco or None, "interno": interno})
    elif op == "provento":
        c["proventos"].append({"id": ident, "investimento": inv["id"], "valor": round(valor, 2), "data": data,
                               "destino": "caixa" if interno or str(a.get("destino") or "").lower().startswith("caixa") else "conta",
                               "conta": a.get("conta") or (c["contas"][0]["nome"] if c["contas"] else None)})
    elif op == "valor_atual":
        c["avaliacoes"].append({"id": ident, "investimento": inv["id"], "valor": round(valor, 2), "data": data})
    else:  # desdobramento, grupamento, bonificação: sem dinheiro; fica no histórico
        c["aportes"].append({"id": ident, "investimento": inv["id"], "valor": 0.0, "data": data, "operacao": op, "quantidade": qtd or None, "interno": True})
    return {"ok": True}


def tem(pid: str, ident: str) -> bool:
    c = ler(pid)
    return any(x.get("id") == ident for k in CHAVES for x in c[k])


def desfazer(pid: str, ident: str | None = None) -> dict[str, Any] | None:
    """Tira o que o pedido `ident` gravou (sem ident: o último registro). Devolve o que saiu."""
    c = ler(pid)
    chaves = CHAVES
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
    if x["_k"] == "proventos":
        return f"Provento {textos.brl(x['valor'])}"
    if x["_k"] == "avaliacoes":
        return f"Valor atual {textos.brl(x['valor'])}"
    return textos.brl(abs(x.get("valor", 0)))
