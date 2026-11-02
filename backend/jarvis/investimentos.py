"""Ferramentas do mentor de investimentos no computador (voz e Telegram usam as mesmas).

- `carteira`: o relatório do motor (`portfolio:report`) resumido por `compactar` — o mesmo resumo vai na cópia do
  Jarvis de bolso, então voz, Telegram e bolso dizem os mesmos números.
- `registrar`: operação já feita (compra, venda, provento, evento, valor atual de um CDB…). Só grava com os campos
  essenciais; o motor recusa repetição (chave ou idêntica em 2 min).
- `perfil`: perfil do investidor e política da carteira, versionados no motor (só com consentimento/aprovação).
- `cotacao`: preço com moeda, horário do dado, horário da coleta e fonte; sem dado, sem número.
- `planejar`: plano de aporte (simulação; nada é gravado) com a carteira e a política reais.
- `metodologia` e `calcular` vêm de mentor.py (sem motor, também no bolso).
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from typing import Any

from . import mentor
from .finance import FinErro, chamar, mudou
from .finance_voz import _achar, _ativas, brl
from .hub import hub

log = logging.getLogger("jarvis.investimentos")

GRUPOS = {"renda_fixa", "acoes_br", "fii_fiagro", "exterior", "cripto", "outros"}
CLASSES = ["ACAO", "FII", "FIAGRO", "ETF", "BDR", "STOCK", "REIT", "ETF_INTERNACIONAL", "CRIPTO", "TESOURO_DIRETO", "CDB", "LCI_LCA",
           "CRI_CRA", "DEBENTURE", "FUNDO", "PREVIDENCIA", "POUPANCA", "RESERVA_EMERGENCIA", "RENDA_FIXA", "OUTROS"]
OPERACOES = {"compra": "COMPRA", "venda": "VENDA", "aporte": "APORTE", "resgate": "RESGATE", "amortizacao": "AMORTIZACAO",
             "desdobramento": "DESDOBRAMENTO", "grupamento": "GRUPAMENTO", "bonificacao": "BONIFICACAO"}


def _r(v: Any, casas: int = 2) -> float | None:
    try:
        return round(float(v), casas)
    except (TypeError, ValueError):
        return None


def _pct(v: Any) -> float | None:
    return None if v is None else round(float(v) * 100, 2)


def compactar(rel: dict[str, Any]) -> dict[str, Any]:
    """O relatório do motor no tamanho certo para o modelo e para a cópia do bolso (números iguais nos canais)."""
    ext, res, inc, perf = rel.get("external") or {}, rel.get("result") or {}, rel.get("income") or {}, rel.get("performance") or {}
    mwr, twr = perf.get("mwr") or {}, perf.get("twr") or {}
    return {
        "gerado_em": rel.get("generatedAt"),
        "data": rel.get("today"),
        "perimetro": rel.get("perimeter"),
        "patrimonio": _r(rel.get("equity")),
        "posicoes": _r(rel.get("marketValue")),
        "caixa_da_carteira": _r(rel.get("cash")),
        "reserva": _r(rel.get("reserve")),
        "do_seu_bolso": {"liquido": _r(ext.get("net")), "entrou": _r(ext.get("inflows")), "saiu": _r(ext.get("outflows")),
                         "no_mes": _r(ext.get("month")), "no_ano": _r(ext.get("year")), "em_12_meses": _r(ext.get("last12")),
                         "saldo_sem_historico": _r(ext.get("inferred"))},
        "resultado": {"total": _r(res.get("total")), "nao_realizado": _r(res.get("unrealized")), "realizado": _r(res.get("realized")),
                      "proventos": _r(res.get("income")), "custos_pagos": _r(res.get("fees")), "formula": res.get("formula")},
        "proventos": {"recebidos_mes": _r((inc.get("received") or {}).get("month")), "recebidos_ano": _r((inc.get("received") or {}).get("year")),
                      "recebidos_12m": _r((inc.get("received") or {}).get("last12")), "recebidos_total": _r((inc.get("received") or {}).get("total")),
                      "a_receber": _r((inc.get("expected") or {}).get("total")), "a_receber_itens": (inc.get("expected") or {}).get("items") or [],
                      "a_confirmar": inc.get("overdue") or 0, "ficaram_no_caixa": _r(inc.get("keptInCash")),
                      "estimados": None, "nota": inc.get("note")},
        "rentabilidade": {
            "xirr": {"metodo": mwr.get("method"), "no_periodo_pct": _pct(mwr.get("value")), "ao_ano_pct": _pct(mwr.get("annualized")),
                     "dias": mwr.get("periodDays"), "motivo_sem_taxa": mwr.get("reason") or None, "ressalva": mwr.get("caveat")},
            "twr_aproximado": {"metodo": twr.get("method"), "no_periodo_pct": _pct(twr.get("value")), "desde": twr.get("from"),
                               "elos": twr.get("links"), "motivo_sem_taxa": twr.get("reason") or None},
            "benchmark": None, "benchmark_nota": "Comparação: o mesmo dinheiro, nas mesmas datas, a 100% do CDI.",
        },
        "alocacao": {"denominador": (rel.get("allocation") or {}).get("denominator"), "tem_politica": (rel.get("allocation") or {}).get("hasPolicy"),
                     "grupos": [{"grupo": g["group"], "nome": g["label"], "valor": _r(g["value"]), "pct": _r(g["pct"]),
                                 "meta_pct": g.get("target"), "desvio_pp": _r(g.get("deviation")), "para_a_meta": _r(g.get("toTarget"))}
                                for g in (rel.get("allocation") or {}).get("byGroup") or []]},
        "concentracao": {"ativos_acima": [{"ativo": a["name"], "pct": _r(a["pct"])} for a in (rel.get("concentration") or {}).get("assets") or []],
                         "referencia": (rel.get("concentration") or {}).get("reference"),
                         "instituicoes": [{"nome": i["name"], "pct": _r(i["pct"])} for i in ((rel.get("concentration") or {}).get("institutions") or [])[:5]]},
        "moedas": [{"moeda": c["currency"], "valor": _r(c["value"])} for c in rel.get("byCurrency") or []],
        "liquidez_a_conferir": rel.get("liquidity") or [],
        "cotacoes": {"mais_recente": (rel.get("quotes") or {}).get("last"), "cobertura": (rel.get("quotes") or {}).get("coverage")},
        "ativos": [{"ativo": a.get("symbol") or a.get("name"), "classe": a.get("classLabel"), "grupo": a.get("group"), "instituicao": a.get("institution"),
                    "quantidade": a.get("quantity"), "preco_medio": a.get("averagePrice"), "preco": a.get("price"), "moeda": a.get("currency"),
                    "preco_em": a.get("priceAt"), "fonte": a.get("priceSource"), "avaliacao": a.get("valuationLabel"),
                    "valor": _r(a.get("marketValue")), "custo": _r(a.get("costBasis")), "resultado_aberto": _r(a.get("unrealized")),
                    "proventos": _r(a.get("income"))} for a in (rel.get("assets") or [])[:40]],
        "evolucao": (rel.get("evolution") or [])[-24:],
        "politica": rel.get("policy"),
        "perfil": rel.get("profile"),
        "lacunas": [{"codigo": g["code"], "texto": g["text"], "itens": (g.get("items") or [])[:8]} for g in rel.get("gaps") or []],
        "eventos_nao_suportados": rel.get("unsupported") or [],
    }


SGS_CDI = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados"


async def _serie_cdi(inicio: str, fim: str) -> dict[str, float]:
    """CDI diário (% ao dia) do Banco Central, guardado por dia para não buscar de novo a cada pergunta."""
    import os

    import httpx

    from . import store

    if os.getenv("JARVIS_TESTE"):
        return {}
    guardado = store.get("cdi_serie") or {}
    if guardado.get("em") == fim and guardado.get("desde", "9999") <= inicio:
        return guardado.get("serie") or {}
    ini = max(dt.date.fromisoformat(inicio), dt.date.fromisoformat(fim) - dt.timedelta(days=3650))  # a API aceita até 10 anos
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.get(SGS_CDI, params={"formato": "json", "dataInicial": ini.strftime("%d/%m/%Y"),
                                                 "dataFinal": dt.date.fromisoformat(fim).strftime("%d/%m/%Y")})
        serie = {f"{x['data'][6:10]}-{x['data'][3:5]}-{x['data'][0:2]}": float(x["valor"]) for x in r.json()} if r.status_code == 200 else {}
    except Exception as exc:  # noqa: BLE001
        log.warning("série do CDI: %s", exc)
        return {}
    if serie:
        store.put("cdi_serie", {"em": fim, "desde": ini.isoformat(), "serie": serie})
    return serie


async def _benchmark(rel: dict[str, Any]) -> dict[str, Any]:
    """O mesmo dinheiro, nas mesmas datas, no CDI — só quando a taxa da carteira também é calculável."""
    mwr = (rel.get("performance") or {}).get("mwr") or {}
    flows = rel.get("flows") or []
    hoje = rel.get("today") or dt.date.today().isoformat()
    base = {"nome": "100% do CDI nas mesmas datas", "fonte": "Banco Central (SGS 12)", "nota": "Sem imposto nem custos; compara o mesmo dinheiro nas mesmas datas."}
    if mwr.get("value") is None:
        return {**base, "valor": None, "motivo": mwr.get("reason") or "A taxa da carteira não é calculável."}
    serie = await _serie_cdi(min(f["date"] for f in flows), hoje)
    v = mentor.valor_no_cdi([(f["date"], f["amount"]) for f in flows], serie, hoje)
    if v is None:
        return {**base, "valor": None, "motivo": "A série do CDI não veio (sem internet ou fora do ar)."}
    eq = float(rel.get("equity") or 0)
    return {**base, "valor": round(v, 2), "carteira": round(eq, 2), "diferenca": round(eq - v, 2), "ate": max(serie)}


async def relatorio() -> dict[str, Any]:
    rel = await chamar("portfolio:report", {"withFlows": True}) or {}
    c = compactar(rel)
    try:
        c["rentabilidade"]["benchmark"] = await _benchmark(rel)
    except Exception as exc:  # noqa: BLE001 - a comparação nunca derruba o relatório
        log.warning("benchmark: %s", exc)
    return c


async def atualizar_diario() -> None:
    """Uma vez por dia: cotações, proventos e a foto do patrimônio (é o que forma a evolução e a rentabilidade)."""
    from . import store

    hoje = dt.date.today().isoformat()
    if (store.get("carteira_atualizada") or {}).get("em") == hoje:
        return
    ativos = [x for x in await chamar("investments:list") or [] if x.get("status") == "ATIVO"]
    if ativos:
        res = await chamar("marketData:refresh") or {}
        log.info("carteira atualizada: %s", res.get("message"))
    store.put("carteira_atualizada", {"em": hoje})


async def loop() -> None:
    import asyncio
    import os

    if os.getenv("JARVIS_TESTE"):
        return
    await asyncio.sleep(120)
    while True:
        try:
            await atualizar_diario()
        except Exception as exc:  # noqa: BLE001
            log.warning("atualização diária da carteira: %s", exc)
        await asyncio.sleep(3600)


def _cartao_dados(c: dict[str, Any], titulo: str = "Carteira de investimentos") -> dict[str, Any]:
    """Cartão da tela (voz) e, no Telegram, o mesmo dado vira texto em textos.carteira."""
    bolso, res, prov = c["do_seu_bolso"], c["resultado"], c["proventos"]
    linhas = [
        {"rotulo": "Do seu bolso (líquido)", "valor": brl(bolso["liquido"])},
        {"rotulo": "Resultado dos investimentos", "valor": brl(res["total"]), "tom": "entrada" if (res["total"] or 0) >= 0 else "saida"},
        {"rotulo": "Proventos em 12 meses", "valor": brl(prov["recebidos_12m"])},
    ]
    if c.get("caixa_da_carteira"):
        linhas.append({"rotulo": "Caixa da carteira", "valor": brl(c["caixa_da_carteira"])})
    if prov.get("a_receber"):
        linhas.append({"rotulo": "A receber", "valor": brl(prov["a_receber"])})
    if c["cotacoes"].get("mais_recente"):
        linhas.append({"rotulo": "Cotação mais recente", "valor": str(c["cotacoes"]["mais_recente"])[:10]})
    barras = [{"rotulo": f"{g['nome']}{f' · meta {g['meta_pct']:g}%' if g.get('meta_pct') is not None else ''}", "valor": g["valor"] or 0}
              for g in c["alocacao"]["grupos"]]
    aviso = " · ".join(l["texto"].split(":")[0] for l in c["lacunas"][:2]) or None
    return {"modo": "carteira", "titulo": titulo, "valor": c["patrimonio"], "sinal": "saldo", "linhas": linhas, "barras": barras,
            "aviso": aviso, "carteira": c}


async def carteira(a: dict[str, Any]) -> dict[str, Any]:
    visao = a.get("visao") or "resumo"
    if visao == "atualizar":
        try:
            await chamar("marketData:refresh")
        except FinErro as exc:
            log.warning("atualizar cotações: %s", exc)
    c = await relatorio()
    await hub.show_card("financeiro", _cartao_dados(c))
    return mentor.visao(c, visao)


def _data(a: dict[str, Any]) -> tuple[str, bool]:
    v = str(a.get("data") or "").strip().lower()
    hoje = dt.date.today()
    if not v or v == "hoje":
        return hoje.isoformat(), not v
    if v == "ontem":
        return (hoje - dt.timedelta(days=1)).isoformat(), False
    try:
        return dt.date.fromisoformat(v[:10]).isoformat(), False
    except ValueError:
        raise FinErro(f"Data '{a.get('data')}' não entendida; use AAAA-MM-DD.") from None


def _num(a: dict[str, Any], k: str) -> float | None:
    v = a.get(k)
    if v in (None, ""):
        return None
    try:
        return float(str(v).replace(",", ".")) if isinstance(v, str) else float(v)
    except ValueError:
        return None


async def registrar(a: dict[str, Any]) -> dict[str, Any]:
    """Registra uma operação JÁ REALIZADA. Sem os campos essenciais, devolve o que falta e não grava."""
    op = str(a.get("operacao") or "").strip().lower()
    if op == "desfazer":
        if not a.get("id"):
            return {"erro": "Qual operação? Passe o id que veio no registro."}
        if not a.get("confirmado"):
            return {"precisa_confirmar": True, "instrucao": "Diga qual operação vai apagar e espere o sim; depois chame com confirmado=true."}
        await chamar("investmentOperations:delete", a["id"])
        await mudou()
        return {"ok": True, "apagada": a["id"]}
    ativos = await chamar("investments:list") or []
    nome = str(a.get("ativo") or "").strip()
    alvo = _achar(nome, ativos, ("symbol", "name")) if nome else None
    faltam = mentor.faltam_registro(a)
    if faltam:
        return {"faltam": faltam, "nada_foi_gravado": True, "ativos_cadastrados": [x.get("symbol") or x.get("name") for x in ativos][:30],
                "instrucao": "Pergunte só o que falta, uma coisa por vez, e chame de novo com tudo."}
    data, assumida = _data(a)
    if op == "valor_atual":
        valor = _num(a, "valor")
        if valor is None:
            faltam.append("valor")
        if faltam or not alvo:
            return {"faltam": faltam or ["ativo cadastrado"], "nada_foi_gravado": True,
                    "ativos": [x.get("symbol") or x.get("name") for x in ativos][:30]}
        await chamar("investments:valuation", alvo["id"], {"value": valor, "date": data})
        await mudou()
        return {"ok": True, "ativo": alvo.get("name"), "valor_atual": brl(valor), "em": data}
    if op == "provento":
        valor = _num(a, "valor")
        if valor is None:
            q, vpu = _num(a, "quantidade"), _num(a, "preco")
            valor = q * vpu if q and vpu else None
        if valor is None:
            faltam.append("valor (total recebido)")
        if faltam or not alvo:
            return {"faltam": faltam or ["ativo cadastrado"], "nada_foi_gravado": True}
        destino = "CAIXA" if str(a.get("origem") or a.get("destino") or "").lower().startswith("caixa") else "EXTERNO"
        situacao = "PREVISTO" if str(a.get("situacao") or "").lower().startswith("prev") else "RECEBIDO"
        item = await chamar("investmentIncome:create", {"investmentId": alvo["id"], "paymentDate": data, "totalAmount": valor,
                                                         "incomeType": str(a.get("tipo_provento") or "DIVIDENDO").upper(),
                                                         "status": situacao, "destination": destino, "externalKey": a.get("chave") or ""})
        await mudou()
        return {"ok": True, "repetido": bool(item.get("duplicate")), "id": item.get("id"), "ativo": alvo.get("symbol") or alvo.get("name"),
                "valor": brl(valor), "situacao": situacao.lower(), "ficou_no_caixa": destino == "CAIXA", "data": data, "data_assumida_hoje": assumida}
    tipo = OPERACOES.get(op)
    if not tipo:
        return {"erro": f"Operação '{op}' desconhecida.", "operacoes": [*OPERACOES, "provento", "valor_atual", "desfazer"]}
    qtd, preco = _num(a, "quantidade"), _num(a, "preco")
    if tipo in ("APORTE", "RESGATE") and not (qtd and preco) and _num(a, "valor"):
        qtd, preco = 1.0, _num(a, "valor")  # CDB, previdência…: aplicação por valor (uma "cota" do valor aplicado)
    if tipo != "AMORTIZACAO" and not qtd:
        faltam.append("quantidade")
    if tipo in ("COMPRA", "VENDA", "APORTE", "RESGATE") and not preco:
        faltam.append("preço unitário")
    if tipo == "AMORTIZACAO" and _num(a, "valor") is None:
        faltam.append("valor recebido")
    if not alvo and nome and not (a.get("classe") and a.get("instituicao")):
        faltam += [f for f, v in (("classe do ativo (ex.: ACAO, FII, CDB, CRIPTO)", a.get("classe")), ("instituição/corretora", a.get("instituicao"))) if not v]
    if faltam:
        return {"faltam": faltam, "nada_foi_gravado": True, "ativos_cadastrados": [x.get("symbol") or x.get("name") for x in ativos][:30],
                "instrucao": "Pergunte só o que falta, uma coisa por vez, e chame de novo com tudo."}
    novo = False
    if not alvo:
        classe = str(a.get("classe")).upper()
        if classe not in CLASSES:
            return {"erro": f"Classe {classe} desconhecida.", "classes": CLASSES, "nada_foi_gravado": True}
        alvo = await chamar("investments:create", {"type": classe, "symbol": nome if classe not in ("CDB", "LCI_LCA", "PREVIDENCIA", "POUPANCA", "FUNDO", "RENDA_FIXA", "OUTROS", "RESERVA_EMERGENCIA", "CRI_CRA", "DEBENTURE") else "",
                                                   "name": nome, "institution": a.get("instituicao"), "currency": a.get("moeda") or None,
                                                   "currentPrice": preco or 0, "autoQuote": True})
        novo = True
    origem = str(a.get("origem") or "").lower()
    dados: dict[str, Any] = {"investmentId": alvo["id"], "operationType": tipo, "quantity": qtd or 0, "unitPrice": preco or 0,
                             "fees": _num(a, "taxas") or 0, "date": data, "externalKey": a.get("chave") or "",
                             "cashSource": "CAIXA" if origem.startswith("caixa") else "EXTERNO", "description": a.get("descricao") or ""}
    if _num(a, "cambio"):
        dados["exchangeRate"] = _num(a, "cambio")
    if tipo == "AMORTIZACAO":
        dados["totalAmount"] = _num(a, "valor")
    if a.get("conta") and not origem.startswith("caixa"):
        conta = _achar(a["conta"], _ativas(await chamar("accounts:list") or []))
        if not conta:
            return {"erro": f"Não achei a conta '{a['conta']}'.", "nada_foi_gravado": not novo}
        dados["bankAccountId"] = conta["id"]
    item = await chamar("investmentOperations:create", dados)
    await mudou()
    from . import textos

    rotulo = {"COMPRA": "Compra", "VENDA": "Venda", "APORTE": "Aporte", "RESGATE": "Resgate", "AMORTIZACAO": "Amortização",
              "DESDOBRAMENTO": "Desdobramento", "GRUPAMENTO": "Grupamento", "BONIFICACAO": "Bonificação"}[tipo]
    linhas = [{"rotulo": "Ativo", "valor": alvo.get("symbol") or alvo.get("name")}, {"rotulo": "Operação", "valor": rotulo},
              {"rotulo": "Quantidade", "valor": f"{qtd:g}" if qtd else "—"}, {"rotulo": "Data", "valor": textos.data_br(data, dt.date.today())},
              {"rotulo": "Dinheiro", "valor": "do caixa da carteira" if dados["cashSource"] == "CAIXA" else ("da conta" if dados.get("bankAccountId") else "de fora da carteira")}]
    if not item.get("duplicate"):
        await hub.show_card("financeiro", {"modo": "lista", "titulo": f"{rotulo} registrada · {alvo.get('symbol') or alvo.get('name')}",
                                           "valor": item.get("totalAmount") or None, "sinal": "neutro", "linhas": linhas})
    return {"ok": True, "repetido": bool(item.get("duplicate")), "id": item.get("id"), "ativo_novo": novo,
            "ativo": alvo.get("symbol") or alvo.get("name"), "operacao": rotulo, "quantidade": qtd, "preco": preco,
            "total": brl(item.get("totalAmount")), "data": data, "data_assumida_hoje": assumida,
            "instrucao": ("Já estava registrada: diga isso, não registre de novo." if item.get("duplicate") else
                          "Confirme numa frase. Se a data foi assumida como hoje, diga isso." )}


async def perfil(a: dict[str, Any]) -> dict[str, Any]:
    acao = a.get("acao") or "ver"
    if acao == "ver":
        return {"perfil": await chamar("portfolio:currentProfile"), "politica": await chamar("portfolio:currentPolicy"),
                "grupos_da_politica": sorted(GRUPOS)}
    if acao == "historico":
        return {"versoes": await chamar("portfolio:history", None)}
    try:
        dados = json.loads(a.get("dados_json") or "{}")
    except json.JSONDecodeError:
        return {"erro": "dados_json não é um JSON válido."}
    if acao == "salvar_perfil":
        if not a.get("autorizado"):
            return {"precisa_confirmar": True, "instrucao": "Pergunte se ele autoriza guardar o perfil de investidor (renda, reserva, objetivos). Só chame com autorizado=true depois do sim."}
        r = await chamar("portfolio:saveProfile", {**dados, "consentimento": True}, a.get("motivo") or "")
        return {"ok": True, "versao": r.get("version")}
    if acao == "salvar_politica":
        if not a.get("aprovada"):
            return {"precisa_confirmar": True, "instrucao": "Mostre a política (metas por grupo, limites) e peça a aprovação dele. Só chame com aprovada=true depois do sim."}
        r = await chamar("portfolio:savePolicy", {**dados, "aprovada": True}, a.get("motivo") or "")
        return {"ok": True, "versao": r.get("version")}
    return {"erro": f"Ação {acao} desconhecida."}


async def cotacao(a: dict[str, Any]) -> dict[str, Any]:
    from . import market

    ativos = [str(x).strip() for x in (a.get("ativos") or []) if str(x).strip()][:8]
    if not ativos:
        return {"erro": "Quais ativos? Ex.: PETR4, IVVB11, BTC-USD, AAPL."}
    res = await market.cotacoes(ativos)
    return {"cotacoes": res, "instrucao": "Diga preço com moeda, de quando é o dado e a fonte. Sem dado = indisponível; nunca estime."}


async def planejar(a: dict[str, Any]) -> dict[str, Any]:
    valor = _num(a, "valor")
    if not valor or valor <= 0:
        return {"erro": "Qual valor do aporte?"}
    c = await relatorio()
    metas, candidatos = None, None
    try:
        if a.get("metas_json"):
            metas = json.loads(a["metas_json"])
        if a.get("candidatos_json"):
            candidatos = json.loads(a["candidatos_json"])
    except json.JSONDecodeError:
        return {"erro": "metas_json ou candidatos_json não é um JSON válido."}
    return mentor.plano_da_carteira(c, valor, metas, candidatos)


DECLS: list[dict[str, Any]] = [
    {"name": "investimentos_carteira",
     "description": ("Carteira de investimentos dele calculada pelo motor: patrimônio, caixa, reserva, do seu bolso (aportes líquidos), "
                     "resultado separado (não realizado, realizado, proventos), proventos recebidos e a receber, rentabilidade com método "
                     "(XIRR / aproximação do TWR), alocação × política, concentração, liquidez, cotações com data e lacunas. "
                     "visao: resumo, proventos, alocacao, evolucao, lacunas, completo; atualizar = busca cotações antes."),
     "parameters": {"type": "OBJECT", "properties": {"visao": {"type": "STRING", "enum": ["resumo", "proventos", "alocacao", "evolucao", "lacunas", "completo", "atualizar"]}}}},
    {"name": "investimentos_registrar",
     "description": ("Registra uma operação que ele JÁ FEZ (nunca uma sugestão). operacao: compra, venda, aporte, resgate, amortizacao, "
                     "provento, desdobramento, grupamento, bonificacao, valor_atual (quanto um CDB/previdência vale hoje), desfazer. "
                     "Precisa de ativo, quantidade e preço unitário (compra/venda), data (AAAA-MM-DD; sem data = hoje). "
                     "origem: 'caixa' se pagou com o dinheiro que estava na carteira (venda/provento anterior); senão é dinheiro de fora. "
                     "conta: conta bancária de onde saiu (opcional). Ativo novo: classe e instituicao. Se faltar algo, pergunte."),
     "parameters": {"type": "OBJECT", "properties": {
         "operacao": {"type": "STRING", "enum": [*OPERACOES, "provento", "valor_atual", "desfazer"]}, "ativo": {"type": "STRING"},
         "quantidade": {"type": "NUMBER"}, "preco": {"type": "NUMBER"}, "valor": {"type": "NUMBER"}, "taxas": {"type": "NUMBER"},
         "data": {"type": "STRING"}, "origem": {"type": "STRING", "enum": ["fora", "caixa"]}, "conta": {"type": "STRING"},
         "classe": {"type": "STRING", "enum": CLASSES}, "instituicao": {"type": "STRING"}, "moeda": {"type": "STRING"}, "cambio": {"type": "NUMBER"},
         "situacao": {"type": "STRING", "enum": ["recebido", "previsto"]}, "id": {"type": "STRING"}, "confirmado": {"type": "BOOLEAN"}},
         "required": ["operacao"]}},
    {"name": "investimentos_perfil",
     "description": ("Perfil de investidor (objetivo, prazo, renda, reserva, dívidas, quanto aguenta perder) e política da carteira "
                     "(metas por grupo: renda_fixa, acoes_br, fii_fiagro, exterior, cripto, outros, somando 100; limite_ativo_pct, "
                     "limite_instituicao_pct). ver, historico, salvar_perfil (autorizado=true só depois do sim), salvar_politica "
                     "(aprovada=true só depois do sim). dados_json = objeto JSON."),
     "parameters": {"type": "OBJECT", "properties": {"acao": {"type": "STRING", "enum": ["ver", "historico", "salvar_perfil", "salvar_politica"]},
                                                     "dados_json": {"type": "STRING"}, "motivo": {"type": "STRING"},
                                                     "autorizado": {"type": "BOOLEAN"}, "aprovada": {"type": "BOOLEAN"}}, "required": ["acao"]}},
    {"name": "investimentos_cotacao",
     "description": "Cotação com moeda, horário do dado, horário da coleta, fonte e atraso (Yahoo Finance; B3 com .SA automático; cripto como BTC-USD).",
     "parameters": {"type": "OBJECT", "properties": {"ativos": {"type": "ARRAY", "items": {"type": "STRING"}}}, "required": ["ativos"]}},
    {"name": "investimentos_planejar",
     "description": ("Plano de aporte (SIMULAÇÃO, não grava): divide o valor pelos grupos abaixo da meta da política, medindo com o patrimônio "
                     "depois do aporte. candidatos_json opcional: [{\"ativo\",\"grupo\",\"preco\",\"lote\",\"taxa\"}] com preços já consultados. "
                     "metas_json só como hipótese quando ele ainda não tem política."),
     "parameters": {"type": "OBJECT", "properties": {"valor": {"type": "NUMBER"}, "candidatos_json": {"type": "STRING"}, "metas_json": {"type": "STRING"}},
                    "required": ["valor"]}},
    mentor.CALCULAR_DECL,
    mentor.METODOLOGIA_DECL,
]


async def run(nome: str, a: dict[str, Any]) -> dict[str, Any]:
    try:
        if nome == "investimentos_metodologia":
            return mentor.metodologia(a.get("tema"))
        if nome == "investimentos_calcular":
            try:
                dados = json.loads(a.get("dados_json") or "{}")
            except json.JSONDecodeError:
                return {"erro": "dados_json não é um JSON válido."}
            return {**mentor.calcular(str(a.get("tipo") or ""), dados), "simulacao": True}
        fn = {"investimentos_carteira": carteira, "investimentos_registrar": registrar, "investimentos_perfil": perfil,
              "investimentos_cotacao": cotacao, "investimentos_planejar": planejar}.get(nome)
        if not fn:
            return {"erro": f"Ferramenta desconhecida: {nome}"}
        return await fn(a)
    except FinErro as exc:
        return {"erro": str(exc), "nada_foi_gravado": True}
