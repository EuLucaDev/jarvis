"""Financeiro completo pela voz: todas as operações do motor como ações prontas, uma ferramenta por área
(fin_<área>), agrupadas em assuntos que a voz carrega quando precisa (as do dia a dia continuam em finance_voz).

As ferramentas saem do catálogo do próprio motor (catalogo.js: parâmetros, campos e obrigatórios lidos do
código), mais dicas dos valores aceitos. Nomes valem no lugar de ids ("conta Nubank", "meta viagem"): cada campo
*Id é resolvido pela lista da área certa. Operações que apagam ou desfazem pedem confirmado=true.
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from typing import Any

from google.genai import types

log = logging.getLogger("jarvis.fin_completo")

S = "STRING"

# assunto → (o que cobre, áreas do motor)
ASSUNTOS: dict[str, tuple[str, list[str]]] = {
    "financeiro_cadastros": ("contas, cartões (limite, recarga de vale), categorias, transferências, perfil e preferências do financeiro",
                             ["accounts", "cards", "categories", "transfers", "profile", "settings"]),
    "financeiro_lancamentos": ("lançamentos a fundo: editar/apagar vários de uma vez, marcar pagos, despesas fixas e receitas recorrentes "
                               "(criar, gerar o mês), contas a pagar, comprovantes anexados",
                               ["expenses", "incomes", "fixedExpenses", "recurringIncomes", "payables", "attachments", "entries"]),
    "financeiro_investimentos": ("investimentos: ativos, compras e vendas, aportes e resgates, proventos, cotações",
                                 ["investments", "investmentOperations", "investmentIncome", "marketData", "contributions"]),
    "financeiro_planejamento": ("metas e itens de meta, orçamento, regras de categoria, análises (assinaturas, fechamento do mês, "
                                "calendário do saldo, ritmo do orçamento, comparação com o ano passado), painel",
                                ["goals", "budgets", "insights", "rules", "dashboard"]),
    "financeiro_relatorios": ("relatórios (completo, extrato, por categoria, comparação anual, razão, CSV), faturas (detalhar, pagar, "
                              "recalcular), leitura de extratos e importação",
                              ["reports", "invoices", "statement", "import"]),
    "financeiro_dados": ("backup (criar, restaurar), exportar/importar dados, apagar lançamentos ou tudo do financeiro, onboarding",
                         ["backup", "data", "app"]),
}

AREAS = {
    "accounts": "contas bancárias", "cards": "cartões de crédito e de benefício", "categories": "categorias",
    "transfers": "transferências entre contas", "profile": "perfil", "settings": "preferências",
    "expenses": "saídas (despesas)", "incomes": "entradas (receitas)", "fixedExpenses": "despesas fixas mensais",
    "recurringIncomes": "receitas recorrentes", "payables": "contas a pagar", "attachments": "comprovantes anexados",
    "entries": "interpretar uma frase de lançamento", "investments": "investimentos (ativos)",
    "investmentOperations": "compras e vendas de ativos", "investmentIncome": "proventos e rendimentos",
    "marketData": "cotações", "contributions": "aportes e resgates", "goals": "metas", "budgets": "orçamento",
    "insights": "análises", "rules": "regras de categoria", "dashboard": "painel", "reports": "relatórios",
    "invoices": "faturas", "statement": "leitura de extratos", "import": "importação de extratos",
    "backup": "backups", "data": "dados (exportar, importar, apagar)", "app": "aplicativo",
}

# o que precisa do "sim" antes (apaga, desfaz, restaura ou mexe em tudo)
PERIGOSAS = re.compile(r":(delete|bulkDelete|depositDelete|itemRemove|reset|clearTransactions|restore|undo|import)$")

DICAS = {
    "paymentMethod": "PIX, DEBITO, DINHEIRO, CARTAO_CREDITO, VALE_BENEFICIO ou META",
    "accountType": "CONTA_CORRENTE, CONTA_POUPANCA, CONTA_DIGITAL, CARTEIRA_DINHEIRO ou OUTROS",
    "cardType": "CREDITO, VALE_ALIMENTACAO, VALE_REFEICAO ou BENEFICIO_FLEXIVEL (crédito pede limit, closingDay e dueDay)",
    "type": "categorias: income, variableExpense, fixedExpense ou investment; investimentos: ACAO, FII, ETF, BDR, STOCK, "
            "CRIPTO, TESOURO_DIRETO, CDB, LCI_LCA, FUNDO, PREVIDENCIA, POUPANCA, RESERVA_EMERGENCIA",
    "status": "despesas: PAGO ou PENDENTE; contas/cartões: ATIVA/INATIVA; itens de meta: PLANEJADO ou PAGO",
    "date": "AAAA-MM-DD", "dueDate": "AAAA-MM-DD", "month": "AAAA-MM", "year": "número, ex. 2026",
    "amount": "número em reais, ex. 92.5",
}

# campo *Id → (lista para achar pelo nome, campos de nome)
REFERENCIAS = {
    "bankAccountId": ("accounts:list", ("name", "bankName")), "fromAccountId": ("accounts:list", ("name", "bankName")),
    "toAccountId": ("accounts:list", ("name", "bankName")), "accountId": ("accounts:list", ("name", "bankName")),
    "creditCardId": ("cards:list", ("name", "bankName")), "cardId": ("cards:list", ("name", "bankName")),
    "goalId": ("goals:list", ("name", "title")), "fixedExpenseId": ("fixedExpenses:list", ("description", "name")),
    "recurringIncomeId": ("recurringIncomes:list", ("description", "name")),
    "investmentId": ("investments:list", ("name", "symbol")),
}

_catalogo: dict[str, dict[str, Any]] = {}


async def preparar() -> None:
    """Lê o catálogo do motor (uma vez, depois que ele sobe)."""
    from . import finance

    import asyncio

    global _catalogo
    for tentativa in range(15):  # o motor pode estar subindo ainda
        try:
            _catalogo = await finance.chamar("app:catalogo") or {}
            return
        except Exception as exc:  # noqa: BLE001
            if tentativa == 14:
                log.info("catálogo do financeiro indisponível: %s", exc)
            await asyncio.sleep(2)


def _assinatura(op: str, info: dict[str, Any]) -> str:
    params = []
    for p in info.get("parametros", []):
        if p == "data" and info.get("campos_data"):
            obrig = set(info.get("obrigatorios", []))
            campos = [f"{c}*" if c in obrig else c for c in info["campos_data"] if c not in ("createdAt", "updatedAt")]
            params.append("data{" + ", ".join(campos) + "}")
        else:
            params.append(p)
    return f"{op.split(':')[1]}({', '.join(params)})" + (" [leitura]" if info.get("leitura") else "")


def declaracoes(assunto: str) -> list[types.FunctionDeclaration]:
    if assunto not in ASSUNTOS or not _catalogo:
        return []
    out = []
    for area in ASSUNTOS[assunto][1]:
        ops = {k: v for k, v in _catalogo.items() if k.split(":")[0] == area}
        if not ops:
            continue
        campos = {c for v in ops.values() for c in v.get("campos_data", [])}
        dicas = "; ".join(f"{c}: {DICAS[c]}" for c in DICAS if c in campos or c in ("date", "amount"))
        out.append(types.FunctionDeclaration(
            name=f"fin_{area}",
            description=(
                f"Financeiro pessoal · {AREAS.get(area, area)}. Operações: " + "; ".join(_assinatura(k, v) for k, v in ops.items())
                + ". Em args_json passe um objeto JSON com os parâmetros pelo nome (ex.: {\"data\": {...}} ou "
                "{\"id\": \"...\", \"data\": {...}}); * = obrigatório. Ids podem ser o nome (conta, cartão, meta, despesa "
                f"fixa, ativo). Valores: {dicas}. Apagar/desfazer/restaurar: confirme com ele e passe confirmado=true."
            ),
            parameters={"type": "OBJECT", "properties": {
                "operacao": {"type": S, "enum": [k.split(":")[1] for k in ops]},
                "args_json": {"type": S},
                "confirmado": {"type": "BOOLEAN"},
            }, "required": ["operacao"]},
        ))
    return out


def e_completo(nome: str) -> bool:
    return nome.startswith("fin_")


def _norm(t: Any) -> str:
    t = unicodedata.normalize("NFD", str(t or "").lower())
    return "".join(c for c in t if unicodedata.category(c) != "Mn").strip()


async def _achar(lista_op: str, campos: tuple[str, ...], valor: str) -> str | None:
    """Id pelo nome: igual, depois contém (sem acento e sem diferença de maiúsculas)."""
    from . import finance

    itens = await finance.chamar(lista_op)
    if isinstance(itens, dict):
        itens = itens.get("items") or itens.get("data") or []
    alvo = _norm(valor)
    if any(isinstance(i, dict) and i.get("id") == valor for i in itens or []):
        return valor
    nomes = [(i.get("id"), " ".join(_norm(i.get(c)) for c in campos)) for i in itens or [] if isinstance(i, dict)]
    for i, n in nomes:
        if any(_norm(i2) == alvo for i2 in n.split("  ")) or n == alvo:
            return i
    achados = [i for i, n in nomes if alvo and alvo in n]
    return achados[0] if len(achados) == 1 else None


async def _resolver(area: str, args: dict[str, Any]) -> dict[str, Any]:
    async def campo(k: str, v: Any) -> Any:
        if k in REFERENCIAS and isinstance(v, str) and v and not v.startswith(k[:-2].lower()):
            achado = await _achar(*REFERENCIAS[k], v)
            if achado:
                return achado
        return v

    if isinstance(args.get("data"), dict):
        args["data"] = {k: await campo(k, v) for k, v in args["data"].items()}
    for k in list(args):
        if k != "data":
            args[k] = await campo(k, args[k])
    # "id" da própria área pelo nome (ex.: apagar a despesa fixa "academia")
    if isinstance(args.get("id"), str) and f"{area}:list" in _catalogo:
        prefixo = re.match(r"^[a-z]+_", args["id"])
        if not prefixo:
            achado = await _achar(f"{area}:list", ("name", "description", "title", "symbol"), args["id"])
            if achado:
                args["id"] = achado
    return args


async def run(nome: str, args: dict[str, Any]) -> dict[str, Any]:
    from . import finance

    area = nome[len("fin_"):]
    op = f"{area}:{args.get('operacao', '')}"
    info = _catalogo.get(op)
    if not info:
        return {"erro": f"Operação desconhecida: {op}."}
    try:
        dados = json.loads(args.get("args_json") or "{}")
    except json.JSONDecodeError as exc:
        return {"erro": f"args_json não é um JSON válido ({exc}). Passe um objeto com os parâmetros pelo nome."}
    if isinstance(dados, list):  # aceita também a lista na ordem dos parâmetros
        dados = dict(zip(info.get("parametros", []), dados))
    if not isinstance(dados, dict):
        return {"erro": "args_json precisa ser um objeto JSON."}
    if PERIGOSAS.search(op) and not args.get("confirmado"):
        return {"precisa_confirmar": True, "operacao": op, "args": dados,
                "instrucao": "Diga a ele exatamente o que vai ser apagado/alterado e pergunte; só depois do sim repita com confirmado=true."}
    faltam = [o for o in info.get("obrigatorios", []) if not (dados.get("data") or {}).get(o) and o not in dados]
    if faltam and "data" in info.get("parametros", []):
        return {"erro": f"Faltam campos obrigatórios em data: {', '.join(faltam)}.", "assinatura": _assinatura(op, info)}
    dados = await _resolver(area, dados)
    posicionais = [dados.get(p) for p in info.get("parametros", [])]
    while posicionais and posicionais[-1] is None:
        posicionais.pop()
    try:
        res = await finance.chamar(op, *posicionais)
    except Exception as exc:  # noqa: BLE001
        return {"erro": str(exc), "assinatura": _assinatura(op, info)}
    if not info.get("leitura"):
        await finance.mudou()
    texto = json.dumps(res, ensure_ascii=False, default=str)
    if len(texto) > 12000:  # listas enormes: o começo basta para a voz
        res = res[:40] if isinstance(res, list) else texto[:12000]
    return {"ok": True, "resultado": res,
            "instrucao": "Responda em uma ou duas frases com o principal; se tiver muitos números, mostre num cartão (mostrar_lista)."}
