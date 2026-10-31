"""Jarvis de bolso: responde o Telegram quando o computador da pessoa está desligado (roda na portaria, leve).

Não roda núcleo, financeiro nem navegador: lê a última cópia que o computador deixou (copia.py), conversa pela
Gemini com a chave da própria pessoa (a chamada vai para o Google; aqui só sai e chega texto) e guarda o que ela
lançar como pendência. Quando o computador conecta, as pendências vão para ele (que aplica no financeiro de verdade
e manda a cópia nova). Assim nunca há dois lugares escrevendo no mesmo banco.

Por conta (DADOS/bolso/<perfil>/, cifrado com PORTARIA_BACKUP_CHAVE): copia.bin, chave.bin, pendencias.json,
conversa.json, botoes.json. Lembretes de todas as contas em DADOS/lembretes.json (disparam com o computador ligado
ou não). Avisos do dia (contas vencendo) saem às 9h quando o computador está desligado.
"""

from __future__ import annotations

import asyncio
import base64
import datetime as dt
import gzip
import json
import logging
import os
import secrets
import time
import unicodedata
from pathlib import Path
from typing import Any

from . import textos

log = logging.getLogger("jarvis.bolso")

GEMINI = os.getenv("BOLSO_GEMINI_URL", "https://generativelanguage.googleapis.com/v1beta")
RESERVA = ["gemini-3.5-flash", "gemini-3.5-flash-lite"]
PASSOS = 8
HISTORICO = 16
_travas: dict[str, asyncio.Lock] = {}


def _p():
    from . import portaria

    return portaria


# ---------------------------------------------------------------- guardar (cifrado)


def _pasta(pid: str) -> Path:
    d = _p().DADOS / "bolso" / pid
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cifra():
    chave = os.getenv("PORTARIA_BACKUP_CHAVE", "")
    if not chave:
        return None
    from cryptography.fernet import Fernet

    return Fernet(chave.encode())


def _gravar(f: Path, dados: Any) -> None:
    bruto = gzip.compress(json.dumps(dados, ensure_ascii=False, default=str).encode())
    c = _cifra()
    tmp = f.with_suffix(".tmp")
    tmp.write_bytes(c.encrypt(bruto) if c else bruto)
    os.chmod(tmp, 0o600)
    tmp.replace(f)


def _ler(f: Path, padrao: Any = None) -> Any:
    if not f.exists():
        return padrao
    try:
        bruto = f.read_bytes()
        c = _cifra()
        return json.loads(gzip.decompress(c.decrypt(bruto) if c else bruto))
    except Exception:  # noqa: BLE001 - arquivo de outra chave ou corrompido: como se não houvesse
        log.warning("não consegui ler %s", f.name)
        return padrao


def guardar_copia(pid: str, copia: dict[str, Any], chave: str) -> None:
    d = _pasta(pid)
    _gravar(d / "copia.bin", copia)
    if chave:
        _gravar(d / "chave.bin", {"chave": chave})


def apagar_copia(pid: str) -> None:
    d = _pasta(pid)
    for nome in ("copia.bin", "chave.bin", "conversa.json"):
        (d / nome).unlink(missing_ok=True)


def copia(pid: str) -> dict[str, Any] | None:
    return _ler(_pasta(pid) / "copia.bin")


def _chave(pid: str) -> str:
    return (_ler(_pasta(pid) / "chave.bin", {}) or {}).get("chave", "")


def disponivel(pid: str) -> bool:
    d = _p().DADOS / "bolso" / pid
    return (d / "copia.bin").exists() and (d / "chave.bin").exists()


def estado(pid: str) -> dict[str, Any]:
    d = _p().DADOS / "bolso" / pid
    f = d / "copia.bin"
    return {"pronto": disponivel(pid), "copia_em": f.stat().st_mtime if f.exists() else None, "pendentes": len(pendencias(pid))}


# ---------------------------------------------------------------- pendências


def pendencias(pid: str) -> list[dict[str, Any]]:
    return _ler(_p().DADOS / "bolso" / pid / "pendencias.json", []) or []


def _por_pendencia(pid: str, item: dict[str, Any]) -> dict[str, Any]:
    item = {"id": f"b{secrets.token_hex(5)}", "em": time.time(), **item}
    lista = pendencias(pid) + [item]
    _gravar(_pasta(pid) / "pendencias.json", lista)
    asyncio.get_event_loop().create_task(despachar(pid))  # computador ligado agora (raro): já vai
    return item


def tem_pendencia(pid: str, ident: str) -> bool:
    return any(x["id"] == ident for x in pendencias(pid))


def tirar_pendencia(pid: str, ident: str | None = None) -> dict[str, Any] | None:
    lista = pendencias(pid)
    alvo = next((x for x in reversed(lista) if (x["id"] == ident if ident else x["ferramenta"] != "pedido")), None)
    if alvo:
        _gravar(_pasta(pid) / "pendencias.json", [x for x in lista if x is not alvo])
    return alvo


def confirmar(pid: str, ids: list[str]) -> None:
    feitos = set(ids)
    _gravar(_pasta(pid) / "pendencias.json", [x for x in pendencias(pid) if x["id"] not in feitos])


def conversas_novas(pid: str) -> dict[str, list[dict[str, Any]]]:
    """As falas trocadas aqui depois da última cópia (o computador junta à conversa dele)."""
    c = copia(pid) or {}
    desde = c.get("gerado", 0)
    conv = _ler(_pasta(pid) / "conversa.json", {}) or {}
    return {chat: [x for x in v.get("linhas", []) if x.get("em", 0) > desde] for chat, v in conv.items()}


async def despachar(pid: str) -> None:
    p = _p()
    lista = pendencias(pid)
    if not lista or not p.conectado(pid):
        return
    for ws in reversed(p._ligados.get(pid, [])):  # noqa: SLF001
        try:
            await ws.send_json({"tipo": "pendencias", "itens": lista, "conversas": conversas_novas(pid)})
            return
        except Exception:  # noqa: BLE001
            continue


# ---------------------------------------------------------------- dados da cópia


def _norm(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", (s or "").lower()) if unicodedata.category(c) != "Mn")


def _fuso(c: dict[str, Any]):
    from zoneinfo import ZoneInfo

    try:
        return ZoneInfo(c.get("fuso") or "America/Sao_Paulo")
    except Exception:  # noqa: BLE001
        return ZoneInfo("America/Sao_Paulo")


def _hoje(c: dict[str, Any]) -> dt.date:
    return dt.datetime.now(_fuso(c)).date()


def _quando(c: dict[str, Any]) -> str:
    t = dt.datetime.fromtimestamp(c.get("gerado") or 0, _fuso(c))
    hoje = _hoje(c)
    dia = "hoje" if t.date() == hoje else "ontem" if t.date() == hoje - dt.timedelta(days=1) else t.strftime("%d/%m")
    return f"{dia} às {t.strftime('%H:%M')}"


def _achar(nome: str, itens: list[dict[str, Any]], campo: str = "nome") -> dict[str, Any] | None:
    n = _norm(nome)
    if not n:
        return None
    return next((i for i in itens if _norm(i.get(campo) or "") == n), None) or next(
        (i for i in itens if n in _norm(i.get(campo) or "") or _norm(i.get(campo) or "") in n), None)


def _efeito(pid: str, conta: str) -> float:
    """Quanto as pendências mexem no saldo de uma conta (para mostrar o saldo estimado)."""
    total = 0.0
    for x in pendencias(pid):
        a = x.get("args") or {}
        if x["ferramenta"] == "financeiro_lancar" and _norm(a.get("conta") or "") == _norm(conta) and a.get("forma") not in ("credito", "vale"):
            total += textos.num(a.get("valor")) * (1 if a.get("tipo") == "entrada" else -1)
        if x["ferramenta"] == "financeiro_transferir":
            if _norm(a.get("de") or "") == _norm(conta):
                total -= textos.num(a.get("valor"))
            if _norm(a.get("para") or "") == _norm(conta):
                total += textos.num(a.get("valor"))
        if x["ferramenta"] in ("financeiro_investir", "financeiro_meta") and _norm(a.get("conta") or "") == _norm(conta):
            sinal = -1 if a.get("acao") in ("aportar", "guardar") else 1
            total += sinal * textos.num(a.get("valor"))
    return total


# ---------------------------------------------------------------- ferramentas

S, N = "STRING", "NUMBER"
FORMAS = ["pix", "debito", "dinheiro", "credito", "vale"]
FORMA_NOME = {"pix": "Pix", "debito": "Débito", "dinheiro": "Dinheiro", "credito": "Crédito", "vale": "Vale"}
DECLS = [
    {"name": "consultar", "description": (
        "Consulta o financeiro (da última cópia): resumo_mes (entradas, saídas, resultado, maiores categorias), gastos_categoria "
        "(categoria), saldos (contas, já com o que foi lançado aqui), a_pagar (dias, padrão 7), faturas, orcamento, metas, investimentos."),
     "parameters": {"type": "OBJECT", "properties": {
         "assunto": {"type": S, "enum": ["resumo_mes", "gastos_categoria", "saldos", "a_pagar", "faturas", "orcamento", "metas", "investimentos"]},
         "mes": {"type": S, "description": "AAAA-MM; vazio = este mês."}, "categoria": {"type": S}, "dias": {"type": "INTEGER"}}, "required": ["assunto"]}},
    {"name": "lancamentos", "description": "Lista gastos e entradas de um mês com filtros (texto como Uber/mercado, categoria, tipo).",
     "parameters": {"type": "OBJECT", "properties": {"mes": {"type": S}, "texto": {"type": S}, "categoria": {"type": S},
                                                     "tipo": {"type": S, "enum": ["gasto", "entrada", "todos"]}}}},
    {"name": "relatorio_financeiro", "description": "Manda o relatório do mês com botões (resumo, despesas, receitas, metas).",
     "parameters": {"type": "OBJECT", "properties": {"mes": {"type": S, "description": "AAAA-MM; vazio = este mês."}}}},
    {"name": "lancar", "description": (
        "Registra um gasto ou uma entrada avulsa (entra no financeiro quando o computador ligar). Preencha valor, tipo, "
        "descricao curta e categoria (use uma das categorias dele). forma/conta/cartao/parcelas/data só se ele disser."),
     "parameters": {"type": "OBJECT", "properties": {
         "tipo": {"type": S, "enum": ["gasto", "entrada"]}, "valor": {"type": N}, "descricao": {"type": S}, "categoria": {"type": S},
         "forma": {"type": S, "enum": FORMAS}, "conta": {"type": S}, "cartao": {"type": S}, "parcelas": {"type": "INTEGER"},
         "data": {"type": S, "description": "AAAA-MM-DD; vazio = hoje."}}, "required": ["tipo", "valor", "descricao", "categoria"]}},
    {"name": "transferir", "description": "Transferência entre contas dele (não é gasto nem entrada).",
     "parameters": {"type": "OBJECT", "properties": {"valor": {"type": N}, "de": {"type": S}, "para": {"type": S}, "data": {"type": S}},
                    "required": ["valor", "de", "para"]}},
    {"name": "meta", "description": "Metas: criar (meta, valor = alvo, prazo AAAA-MM-DD) ou guardar/retirar dinheiro de uma meta.",
     "parameters": {"type": "OBJECT", "properties": {"acao": {"type": S, "enum": ["criar", "guardar", "retirar"]}, "meta": {"type": S},
                                                     "valor": {"type": N}, "prazo": {"type": S}, "conta": {"type": S}}, "required": ["acao", "meta", "valor"]}},
    {"name": "investir", "description": "Aporte ou resgate num investimento que ele já tem.",
     "parameters": {"type": "OBJECT", "properties": {"acao": {"type": S, "enum": ["aportar", "resgatar"]}, "investimento": {"type": S},
                                                     "valor": {"type": N}, "conta": {"type": S}, "data": {"type": S}}, "required": ["acao", "investimento", "valor"]}},
    {"name": "desfazer", "description": "Desfaz o último registro feito aqui pelo celular.", "parameters": {"type": "OBJECT", "properties": {}}},
    {"name": "buscar_memorias", "description": "Procura na memória dele (fatos, gostos, pessoas, projetos).",
     "parameters": {"type": "OBJECT", "properties": {"consulta": {"type": S}}, "required": ["consulta"]}},
    {"name": "lembrar", "description": "Guarda algo na memória de longo prazo (uma frase autossuficiente, na terceira pessoa).",
     "parameters": {"type": "OBJECT", "properties": {"texto": {"type": S}, "tipo": {"type": S}}, "required": ["texto"]}},
    {"name": "criar_lembrete", "description": "Agenda um lembrete aqui no Telegram ('me lembra amanhã às 9h de pagar o boleto').",
     "parameters": {"type": "OBJECT", "properties": {"texto": {"type": S}, "quando": {"type": S, "description": "AAAA-MM-DDTHH:MM, hora local."}},
                    "required": ["texto", "quando"]}},
    {"name": "pedido_para_o_computador", "description": (
        "Guarda um pedido que só o Jarvis do computador faz (sistemas como o WorkFlow, importar extrato, editar ou apagar "
        "lançamentos antigos, pagar contas, fixas, mexer no computador). Ele faz e responde aqui assim que o computador ligar."),
     "parameters": {"type": "OBJECT", "properties": {"texto": {"type": S, "description": "O pedido completo, como ele disse."}}, "required": ["texto"]}},
    {"name": "pendentes", "description": "O que foi registrado aqui pelo celular e ainda vai entrar no computador.", "parameters": {"type": "OBJECT", "properties": {}}},
]


class Resposta:
    def __init__(self) -> None:
        self.texto = ""
        self.mensagens: list[dict[str, Any]] = []  # {texto, teclado?}
        self.ferramentas: list[tuple[str, dict[str, Any]]] = []


def _mes(c: dict[str, Any], a: dict[str, Any]) -> str:
    m = str(a.get("mes") or "").strip()
    return m[:7] if len(m) >= 7 else _hoje(c).strftime("%Y-%m")


def _dados_mes(c: dict[str, Any], mes: str) -> dict[str, Any] | None:
    return ((c.get("financeiro") or {}).get("meses") or {}).get(mes)


def _pendentes_txt(pid: str) -> list[str]:
    return [x.get("resumo") or x["ferramenta"] for x in pendencias(pid) if x["ferramenta"] != "pedido"]


async def _ferramenta(pid: str, chat: int, nome: str, a: dict[str, Any], c: dict[str, Any], resp: Resposta) -> dict[str, Any]:
    fin = c.get("financeiro")
    nota = f"Cópia de {_quando(c)}."
    if nome in ("consultar", "lancamentos", "relatorio_financeiro", "lancar", "transferir", "meta", "investir") and not fin:
        return {"erro": "O financeiro não veio na cópia deste computador."}
    if nome == "consultar":
        assunto = a.get("assunto") or "resumo_mes"
        mes = _mes(c, a)
        base = {"copia_de": _quando(c), "pendentes_aqui": _pendentes_txt(pid)}
        if assunto in ("resumo_mes", "gastos_categoria"):
            dm = _dados_mes(c, mes)
            if not dm:
                return {"erro": "Aqui tenho só os últimos três meses. O resto, quando o computador ligar."}
            d = dm["d"]
            if assunto == "gastos_categoria":
                alvo = _norm(a.get("categoria") or "")
                itens = [g for g in dm["gastos"] if alvo and (alvo in _norm(g["categoria"]) or alvo in _norm(g["descricao"]))]
                total = sum(g["valor"] for g in itens)
                return {**base, "mes": textos.rotulo_mes(mes), "categoria": a.get("categoria"), "total": textos.brl(total), "lancamentos": len(itens),
                        "media": textos.brl(total / len(itens)) if itens else "—", "parte_das_despesas": textos.pct_txt(textos.pct(total, d.get("totalOutflow"))),
                        "emoji": textos.emoji_categoria(a.get("categoria") or "")}
            return {**base, "mes": textos.rotulo_mes(mes), "entradas": textos.brl(d.get("totalIncome")), "saidas": textos.brl(d.get("totalOutflow")),
                    "resultado": textos.brl(textos.num(d.get("totalIncome")) - textos.num(d.get("totalOutflow")), sinal=True),
                    "investido": textos.brl(d.get("contributionTotal")), "faturas_abertas": textos.brl(d.get("openInvoiceTotal")),
                    "saldo_total": textos.brl(d.get("totalBalance")),
                    "categorias": [f"{x['name']}: {textos.brl(x['value'])}" for x in (d.get("expensesByCategory") or [])[:6]],
                    "analise": textos.analise(dm)}
        if assunto == "saldos":
            contas = [{"conta": x["nome"], "saldo": textos.brl(textos.num(x.get("saldo")) + _efeito(pid, x["nome"]))} for x in fin.get("contas") or []]
            total = sum(textos.num(x.get("saldo")) + _efeito(pid, x["nome"]) for x in fin.get("contas") or [])
            return {**base, "total": textos.brl(total), "contas": contas}
        if assunto == "a_pagar":
            limite = _hoje(c) + dt.timedelta(days=int(a.get("dias") or 7))
            itens = [x for x in fin.get("a_pagar") or [] if x.get("vence", "9999") <= limite.isoformat()]
            return {**base, "itens": [f"{x['titulo']} {textos.brl(x['valor'])}, vence {textos.data_br(x['vence'], _hoje(c))}" for x in itens] or "Nada vencendo."}
        if assunto == "faturas":
            dm = _dados_mes(c, _hoje(c).strftime("%Y-%m")) or {"d": {}}
            return {**base, "faturas": [f"{x['name']}: {textos.brl(x['value'])}" for x in dm["d"].get("invoicesByCard") or [] if textos.num(x.get("value"))] or "Nenhuma aberta."}
        if assunto == "orcamento":
            return {**base, "orcamento": [f"{x['categoria']}: {round(textos.num(x.get('pct')))}% ({textos.brl(x.get('usado'))} de {textos.brl(x.get('limite'))})"
                                          + (", vai estourar no ritmo atual" if x.get("vai_estourar") else "") for x in fin.get("orcamento") or []] or "Sem orçamento definido."}
        if assunto == "metas":
            return {**base, "metas": [f"{m['nome']}: {textos.brl(m.get('guardado'))} de {textos.brl(m.get('alvo'))}" for m in fin.get("metas") or [] if m.get("status", "ATIVA") == "ATIVA"]}
        if assunto == "investimentos":
            inv = fin.get("investimentos") or {}
            return {**base, "total": textos.brl(inv.get("total")), "ativos": [f"{x['nome']}: {textos.brl(x.get('valor'))}" for x in inv.get("ativos") or []]}
        return {"erro": f"Assunto desconhecido: {assunto}"}
    if nome == "lancamentos":
        dm = _dados_mes(c, _mes(c, a))
        if not dm:
            return {"erro": "Aqui tenho só os últimos três meses."}
        tipo = a.get("tipo") or "todos"
        itens = ([{**g, "tipo": "gasto"} for g in dm["gastos"]] if tipo != "entrada" else []) + ([{**r, "tipo": "entrada"} for r in dm["receitas"]] if tipo != "gasto" else [])
        if a.get("texto"):
            itens = [i for i in itens if _norm(a["texto"]) in _norm(i["descricao"])]
        if a.get("categoria"):
            itens = [i for i in itens if _norm(a["categoria"]) in _norm(i["categoria"])]
        itens.sort(key=lambda i: i["data"], reverse=True)
        return {"copia_de": _quando(c), "total": textos.brl(sum(i["valor"] for i in itens)), "quantidade": len(itens),
                "itens": [f"{i['data'][8:10]}/{i['data'][5:7]} {i['descricao']} · {i['categoria']} · {textos.brl(i['valor'] if i['tipo'] == 'entrada' else -i['valor'])}" for i in itens[:25]]}
    if nome == "relatorio_financeiro":
        mes = _mes(c, a)
        dm = _dados_mes(c, mes)
        if not dm:
            return {"erro": "Aqui tenho só os últimos três meses."}
        resp.mensagens.append({"texto": textos.relatorio_secao(dm, "resumo", nota), "teclado": textos.teclado_relatorio(mes, "resumo")})
        return {"ok": True, "instrucao": "O relatório já foi mandado. Comente em uma frase, sem repetir números."}
    if nome == "lancar":
        valor = abs(textos.num(a.get("valor")))
        if not valor:
            return {"erro": "Faltou o valor."}
        forma = a.get("forma") if a.get("forma") in FORMAS else None
        cartao = _achar(a.get("cartao") or "", fin.get("cartoes") or [])
        if a.get("cartao") and not cartao:
            return {"erro": f"Não achei o cartão '{a['cartao']}'.", "cartoes": [x["nome"] for x in fin.get("cartoes") or []]}
        if cartao and forma not in ("credito", "vale"):
            forma = "credito" if cartao.get("tipo") == "CREDITO" else "vale"
        contas = fin.get("contas") or []
        conta = _achar(a.get("conta") or "", contas) if a.get("conta") else None
        if a.get("conta") and not conta:
            return {"erro": f"Não achei a conta '{a['conta']}'.", "contas": [x["nome"] for x in contas]}
        conta = conta or (contas[0] if contas else None)
        data = str(a.get("data") or _hoje(c).isoformat())[:10]
        entrada = a.get("tipo") == "entrada"
        args = {"tipo": "entrada" if entrada else "gasto", "valor": valor, "descricao": a.get("descricao"), "categoria": a.get("categoria"),
                "data": data, "forma": forma or ("pix" if not entrada else None), "conta": conta and conta["nome"],
                "cartao": cartao and cartao["nome"], "parcelas": a.get("parcelas")}
        args = {k: v for k, v in args.items() if v not in (None, "")}
        item = _por_pendencia(pid, {"chat": chat, "ferramenta": "financeiro_lancar", "args": args,
                                    "resumo": f"{a.get('descricao')} · {textos.brl(valor if entrada else -valor, sinal=entrada)}"})
        onde = f"{cartao['nome']} · {FORMA_NOME.get(forma or '', '')}" + (f" {a['parcelas']}x" if a.get("parcelas") and int(a["parcelas"]) > 1 else "") if cartao \
            else f"{conta['nome'] if conta else '—'} · {FORMA_NOME.get(args.get('forma', ''), 'Pix')}"
        rodape = ""
        if conta and forma not in ("credito", "vale"):
            rodape = f"💰 Saldo estimado ({textos.e(conta['nome'])}): <b>{textos.brl(textos.num(conta.get('saldo')) + _efeito(pid, conta['nome']))}</b>"
        msg = textos.registro("entrada" if entrada else "despesa", valor, [
            (textos.emoji_categoria(a.get("categoria") or ""), "Categoria", a.get("categoria")), ("📝", "Descrição", a.get("descricao")),
            ("📅", "Data", textos.data_br(data, _hoje(c))), ("🏦" if entrada else "💳", "Recebido em" if entrada else "Pago com", onde)],
            rodape=rodape, nota="⏳ Entra no seu financeiro quando o computador ligar.")
        resp.mensagens.append({"texto": msg, "teclado": {"inline_keyboard": [[{"text": "Desfazer", "callback_data": f"n:d:{item['id']}"}]]}})
        return {"ok": True, "ja_mostrado": "O cartão do registro já foi mandado. Responda só com uma frase curta, no máximo."}
    if nome == "transferir":
        contas = fin.get("contas") or []
        de, para = _achar(a.get("de") or "", contas), _achar(a.get("para") or "", contas)
        if not de or not para:
            return {"erro": "Não achei as duas contas.", "contas": [x["nome"] for x in contas]}
        valor = abs(textos.num(a.get("valor")))
        data = str(a.get("data") or _hoje(c).isoformat())[:10]
        item = _por_pendencia(pid, {"chat": chat, "ferramenta": "financeiro_transferir", "args": {"valor": valor, "de": de["nome"], "para": para["nome"], "data": data},
                                    "resumo": f"Transferência {de['nome']} → {para['nome']} · {textos.brl(valor)}"})
        msg = textos.registro("transferencia", valor, [("↗️", "De", de["nome"]), ("↘️", "Para", para["nome"]), ("📅", "Data", textos.data_br(data, _hoje(c)))],
                              nota="Não conta como gasto. ⏳ Entra no seu financeiro quando o computador ligar.")
        resp.mensagens.append({"texto": msg, "teclado": {"inline_keyboard": [[{"text": "Desfazer", "callback_data": f"n:d:{item['id']}"}]]}})
        return {"ok": True, "ja_mostrado": "O cartão já foi mandado. No máximo uma frase curta."}
    if nome == "meta":
        acao, valor = a.get("acao"), abs(textos.num(a.get("valor")))
        metas = (fin.get("metas") or []) + [{"nome": x["args"]["meta"], "alvo": x["args"]["valor"], "guardado": 0} for x in pendencias(pid)
                                            if x["ferramenta"] == "financeiro_meta" and x["args"].get("acao") == "criar"]
        if acao == "criar":
            item = _por_pendencia(pid, {"chat": chat, "ferramenta": "financeiro_meta", "args": {"acao": "criar", "meta": a.get("meta"), "valor": valor, "prazo": a.get("prazo") or ""},
                                        "resumo": f"Meta {a.get('meta')} · alvo {textos.brl(valor)}"})
            msg = textos.registro("meta", 0, [("💰", "Objetivo", textos.brl(valor)), ("📅", "Prazo", textos.data_br(a["prazo"]) if a.get("prazo") else "Não definido"),
                                              ("📌", "Status", "Em andamento")], destaque=a.get("meta"),
                                  rodape=f"Valor acumulado · <b>R$ 0,00</b>\n{textos.progresso(0, valor)}💡 Quer definir um prazo e um aporte mensal?",
                                  nota="⏳ Entra no seu financeiro quando o computador ligar.")
        else:
            m = _achar(a.get("meta") or "", metas)
            if not m:
                return {"erro": f"Não achei a meta '{a.get('meta')}'.", "metas": [x["nome"] for x in metas]}
            novo = textos.num(m.get("guardado")) + (valor if acao == "guardar" else -valor)
            conta = _achar(a.get("conta") or "", fin.get("contas") or []) or ((fin.get("contas") or [None])[0])
            item = _por_pendencia(pid, {"chat": chat, "ferramenta": "financeiro_meta", "args": {"acao": acao, "meta": m["nome"], "valor": valor, "conta": conta and conta["nome"]},
                                        "resumo": f"{'Guardar em' if acao == 'guardar' else 'Retirar de'} {m['nome']} · {textos.brl(valor)}"})
            msg = textos.registro("meta_deposito" if acao == "guardar" else "meta_retirada", valor, [("🎯", "Meta", m["nome"]), ("🏦", "Conta", conta and conta["nome"])],
                                  rodape=f"Acumulado · <b>{textos.brl(novo)}</b> de {textos.brl(m.get('alvo'))}\n{textos.progresso(novo, textos.num(m.get('alvo')))}",
                                  nota="⏳ Entra no seu financeiro quando o computador ligar.")
        resp.mensagens.append({"texto": msg, "teclado": {"inline_keyboard": [[{"text": "Desfazer", "callback_data": f"n:d:{item['id']}"}]]}})
        return {"ok": True, "ja_mostrado": "O cartão já foi mandado. No máximo uma frase curta."}
    if nome == "investir":
        inv = (fin.get("investimentos") or {}).get("ativos") or []
        alvo = _achar(a.get("investimento") or "", inv)
        if not alvo:
            return {"erro": f"Não achei '{a.get('investimento')}' nos investimentos dele.", "investimentos": [x["nome"] for x in inv][:20],
                    "instrucao": "Investimento novo: use pedido_para_o_computador."}
        valor = abs(textos.num(a.get("valor")))
        data = str(a.get("data") or _hoje(c).isoformat())[:10]
        conta = _achar(a.get("conta") or "", fin.get("contas") or []) or ((fin.get("contas") or [None])[0])
        acao = a.get("acao") or "aportar"
        item = _por_pendencia(pid, {"chat": chat, "ferramenta": "financeiro_investir", "args": {"acao": acao, "investimento": alvo["nome"], "valor": valor, "conta": conta and conta["nome"], "data": data},
                                    "resumo": f"{'Aporte' if acao == 'aportar' else 'Resgate'} {alvo['nome']} · {textos.brl(valor)}"})
        msg = textos.registro("investimento" if acao == "aportar" else "resgate", valor, [
            ("📈", "Ativo", alvo["nome"]), ("🏷️", "Operação", "Aplicação" if acao == "aportar" else "Resgate"), ("📅", "Data", textos.data_br(data, _hoje(c))),
            ("💼", "Posição antes", textos.brl(alvo.get("valor")))], nota="Rentabilidade não incluída. ⏳ Entra no seu financeiro quando o computador ligar.")
        resp.mensagens.append({"texto": msg, "teclado": {"inline_keyboard": [[{"text": "Desfazer", "callback_data": f"n:d:{item['id']}"}]]}})
        return {"ok": True, "ja_mostrado": "O cartão já foi mandado. No máximo uma frase curta."}
    if nome == "desfazer":
        x = tirar_pendencia(pid)
        return {"ok": True, "desfeito": x.get("resumo")} if x else {"erro": "Não há nada feito aqui pelo celular para desfazer."}
    if nome == "buscar_memorias":
        termos = [t for t in _norm(a.get("consulta") or "").split() if len(t) > 2]
        mems = [{"texto": x["args"]["texto"]} for x in pendencias(pid) if x["ferramenta"] == "lembrar"] + (c.get("memorias") or [])
        pont = sorted(((sum(t in _norm(m["texto"]) for t in termos), m["texto"]) for m in mems), reverse=True)
        achadas = [t for p, t in pont if p > 0][:8]
        return {"memorias": achadas or "Nada guardado sobre isso."}
    if nome == "lembrar":
        _por_pendencia(pid, {"chat": chat, "ferramenta": "lembrar", "args": {"texto": a.get("texto"), "tipo": a.get("tipo") or "nota"}, "resumo": f"Memória: {a.get('texto', '')[:60]}"})
        return {"ok": True}
    if nome == "criar_lembrete":
        try:
            t = dt.datetime.fromisoformat(str(a.get("quando", "")).strip())
        except ValueError:
            return {"erro": "Não entendi a data e a hora."}
        if t.tzinfo is None:
            t = t.replace(tzinfo=_fuso(c))
        if t.timestamp() < time.time() - 60:
            return {"erro": "Esse horário já passou."}
        agendar(pid, chat, str(a.get("texto", "")), t.timestamp())
        return {"ok": True, "quando": t.strftime("%d/%m às %H:%M")}
    if nome == "pedido_para_o_computador":
        _por_pendencia(pid, {"chat": chat, "ferramenta": "pedido", "args": {"texto": a.get("texto", "")}, "resumo": a.get("texto", "")[:60]})
        return {"ok": True, "instrucao": "Diga numa frase que ficou guardado e que ele responde aqui assim que o computador ligar."}
    if nome == "pendentes":
        return {"pendentes": _pendentes_txt(pid) or "Nada pendente."}
    return {"erro": "Isso não está disponível aqui."}


def _prompt(c: dict[str, Any]) -> str:
    nome, chamar = c.get("nome") or "", c.get("chamar") or ""
    trato = f'Chame a pessoa de "{chamar}".' if chamar and chamar != nome else f"Chame a pessoa pelo nome, {nome}."
    agora = dt.datetime.now(_fuso(c)).strftime("%A, %d/%m/%Y, %H:%M")
    fin = c.get("financeiro") or {}
    cats = fin.get("categorias") or {}
    nomes_cat = sorted({(x.get("name") if isinstance(x, dict) else str(x)) for v in cats.values() if isinstance(v, list) for x in v} - {None})[:60]
    contas = ", ".join(x["nome"] for x in fin.get("contas") or []) or "nenhuma"
    cartoes = ", ".join(x["nome"] for x in fin.get("cartoes") or []) or "nenhum"
    return f"""Você é J.A.R.V.I.S., o assistente pessoal de {nome}. {trato} Vocês conversam pelo Telegram.
Português do Brasil, jeito do J.A.R.V.I.S. dos filmes: formal sem ser frio, curto e preciso, ironia leve às vezes.
Agora são {agora}. Cidade: {c.get('cidade') or ''}.

O computador dele está desligado agora: você responde com a última cópia do Jarvis dele ({_quando(c)}). Você tem o
financeiro (últimos três meses, contas, cartões, o que vence, metas, investimentos) e a memória dele.
- Registros (lancar, transferir, meta, investir, lembrar) ficam guardados e entram no financeiro quando o computador
  ligar; o cartão já avisa isso, não repita.
- Só o computador faz: sistemas (WorkFlow), importar extrato, editar/apagar lançamentos antigos, pagar contas,
  despesas fixas, abrir coisas no computador. Para isso, pedido_para_o_computador (ele faz e responde aqui depois).
- Áudio: entenda e aja. Foto de nota fiscal, cupom ou comprovante de Pix: leia valor, data, estabelecimento e forma,
  proponha o lançamento e só lance depois do sim.
- Não invente números: consulte. Se a pergunta for sobre algo depois da cópia, diga de quando é a cópia.
- NUNCA diga que registrou ou guardou algo sem ter chamado a ferramenta e recebido ok.

Contas: {contas}. Cartões: {cartoes}. Categorias dele: {', '.join(nomes_cat) or 'as de sempre'}.

Como responder: {textos.ESTILO}
"""


# ---------------------------------------------------------------- Gemini (REST, só texto e anexos pequenos)


async def _gerar(chave: str, modelos: list[str], corpo: dict[str, Any]) -> dict[str, Any] | None:
    """Tenta os modelos na ordem; o que falhar (cota, fora do ar) sai da lista desta conversa."""
    for m in list(modelos):
        try:
            r = await _p().http().post(f"{GEMINI}/models/{m}:generateContent", json=corpo, headers={"x-goog-api-key": chave}, timeout=90)
            if r.status_code == 200:
                return r.json()
            log.warning("bolso %s: %s %s", m, r.status_code, r.text[:160].replace("\n", " "))
            if r.status_code in (400, 401, 403) and "API key" in r.text:
                return {"erro_chave": True}
        except Exception as exc:  # noqa: BLE001
            log.warning("bolso %s: %s", m, exc)
        if len(modelos) > 1:
            modelos.remove(m)
    return None


def _conversa(pid: str, chat: str, c: dict[str, Any]) -> list[dict[str, Any]]:
    conv = _ler(_pasta(pid) / "conversa.json", {}) or {}
    atual = conv.get(chat) or {}
    if atual.get("em", 0) < c.get("gerado", 0):  # a cópia é mais nova: a conversa do computador vale
        return [{"papel": x["papel"], "texto": x["texto"], "em": 0} for x in (c.get("conversas") or {}).get(chat, [])][-HISTORICO:]
    return atual.get("linhas", [])[-HISTORICO:]


def _guardar_conversa(pid: str, chat: str, linhas: list[dict[str, Any]]) -> None:
    conv = _ler(_pasta(pid) / "conversa.json", {}) or {}
    conv[chat] = {"linhas": linhas[-HISTORICO:], "em": time.time()}
    _gravar(_pasta(pid) / "conversa.json", conv)


async def responder(pid: str, chat: int, partes: list[dict[str, Any]], resumo: str) -> Resposta:
    c = copia(pid) or {}
    resp = Resposta()
    chave = _chave(pid)
    linhas = _conversa(pid, str(chat), c)
    contents = [{"role": x["papel"], "parts": [{"text": x["texto"]}]} for x in linhas] + [{"role": "user", "parts": partes}]
    modelos = [m for m in [c.get("modelo"), *RESERVA] if m]
    for _ in range(PASSOS):
        r = await _gerar(chave, modelos, {"systemInstruction": {"parts": [{"text": _prompt(c)}]}, "contents": contents,
                                          "tools": [{"functionDeclarations": DECLS}]})
        if not r or r.get("erro_chave"):
            resp.texto = ("A chave da Gemini do seu Jarvis não foi aceita. Abra o Jarvis no computador para atualizar."
                          if r else "Os modelos da Gemini não responderam agora. Tente de novo em um minuto.")
            break
        cand = (r.get("candidates") or [{}])[0]
        conteudo = cand.get("content") or {"role": "model", "parts": []}
        chamadas = [p["functionCall"] for p in conteudo.get("parts") or [] if p.get("functionCall")]
        if not chamadas:
            resp.texto = "".join(p.get("text", "") for p in conteudo.get("parts") or [] if p.get("text") and not p.get("thought")).strip()
            break
        contents.append({"role": "model", "parts": conteudo.get("parts")})
        respostas = []
        for fc in chamadas:
            try:
                res = await _ferramenta(pid, chat, fc.get("name", ""), dict(fc.get("args") or {}), c, resp)
            except Exception as exc:  # noqa: BLE001
                log.exception("ferramenta %s", fc.get("name"))
                res = {"erro": str(exc)[:200]}
            resp.ferramentas.append((fc.get("name", ""), res))
            fr = {"name": fc.get("name"), "response": res}
            if fc.get("id"):
                fr["id"] = fc["id"]
            respostas.append({"functionResponse": fr})
        contents.append({"role": "user", "parts": respostas})
    else:
        resp.texto = resp.texto or "Fiz o que deu; diga se quer que eu continue."
    if not resp.texto and resp.mensagens:
        resp.texto = ""
    agora = time.time()
    _guardar_conversa(pid, str(chat), linhas + [{"papel": "user", "texto": resumo[:2000], "em": agora},
                                                {"papel": "model", "texto": (resp.texto or "(mandou o cartão)")[:2000], "em": agora}])
    return resp


# ---------------------------------------------------------------- Telegram


async def _enviar(chat: int, texto: str, teclado: dict[str, Any] | None = None, html_pronto: bool = True) -> None:
    p = _p()
    dados: dict[str, Any] = {"chat_id": chat, "text": texto[:4000], "parse_mode": "HTML", "disable_web_page_preview": True}
    if teclado:
        dados["reply_markup"] = teclado
    r = await p.tg("sendMessage", dados)
    if not r.get("ok"):
        dados.pop("parse_mode")
        await p.tg("sendMessage", dados)


def _html(texto: str) -> str:
    """Markdown simples da Gemini → HTML do Telegram (o mesmo do Jarvis do computador)."""
    import html as h
    import re

    t = h.escape(texto or "", quote=False)
    t = re.sub(r"```(?:\w+)?\n?(.*?)```", lambda m: f"<pre>{m.group(1).strip()}</pre>", t, flags=re.S)
    t = re.sub(r"`([^`\n]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<![\w*])\*(?!\s)([^*\n]+?)\*(?!\w)", r"<i>\1</i>", t)
    t = re.sub(r"^#{1,6}\s*(.+)$", r"<b>\1</b>", t, flags=re.M)
    t = re.sub(r"^\s*[-*]\s+", "• ", t, flags=re.M)
    return t.strip()


def _botoes(pid: str, opcoes: list[tuple[str, str]]) -> dict[str, Any]:
    f = _pasta(pid) / "botoes.json"
    mapa = _ler(f, {}) or {}
    linha = []
    for rotulo, texto in opcoes:
        k = secrets.token_hex(5)
        mapa[k] = {"texto": texto, "em": time.time()}
        linha.append({"text": rotulo, "callback_data": f"c:{k}"})
    _gravar(f, dict(sorted(mapa.items(), key=lambda kv: kv[1]["em"])[-200:]))
    return {"inline_keyboard": [linha]}


async def _baixar(file_id: str) -> bytes:
    p = _p()
    info = await p.tg("getFile", {"file_id": file_id})
    caminho = info["result"]["file_path"]
    r = await p.http().get(f"{p.TG}/file/bot{p._tg_token()}/{caminho}", timeout=120)  # noqa: SLF001
    return r.content


AJUDA = ("<b>Jarvis</b> · seu computador está desligado, então quem responde é o Jarvis de bolso, com a última cópia.\n\n"
         "• Pergunte do financeiro, peça o <b>relatório do mês</b>, saldos, metas\n"
         "• Lance gastos e entradas (por texto, áudio ou foto do comprovante): entram no financeiro quando o computador ligar\n"
         "• \"Me lembra amanhã às 9h de pagar o boleto\"\n"
         "• O resto (WorkFlow, importar extrato) fica guardado e o computador faz assim que ligar")
COMANDOS = {"/hoje": "Me dê o resumo de hoje: saldo, o que vence nos próximos dias e orçamento apertado.",
            "/contas": "O que vence nos próximos 7 dias?"}


async def tratar(pid: str, upd: dict[str, Any]) -> None:
    trava = _travas.setdefault(pid, asyncio.Lock())
    async with trava:
        try:
            await _tratar(pid, upd)
        except Exception:  # noqa: BLE001
            log.exception("Jarvis de bolso")


async def _tratar(pid: str, upd: dict[str, Any]) -> None:
    p = _p()
    c = copia(pid) or {}
    if "callback_query" in upd:
        cq = upd["callback_query"]
        msg = cq["message"]
        chat = msg["chat"]["id"]
        dado = cq.get("data") or ""
        if dado.startswith("r:"):
            _, secao, mes = dado.split(":", 2)
            dm = _dados_mes(c, mes)
            if not dm:
                await p.tg("answerCallbackQuery", {"callback_query_id": cq["id"], "text": "Esse mês não está na cópia; peça com o computador ligado."})
                return
            await p.tg("answerCallbackQuery", {"callback_query_id": cq["id"]})
            await p.tg("editMessageText", {"chat_id": chat, "message_id": msg["message_id"], "text": textos.relatorio_secao(dm, secao, f"Cópia de {_quando(c)}."),
                                           "parse_mode": "HTML", "reply_markup": textos.teclado_relatorio(mes, secao)})
            return
        await p.tg("answerCallbackQuery", {"callback_query_id": cq["id"]})
        await p.tg("editMessageReplyMarkup", {"chat_id": chat, "message_id": msg["message_id"], "reply_markup": {"inline_keyboard": []}})
        if dado.startswith("n:d:"):
            x = tirar_pendencia(pid, dado[4:])
            if x:
                await _enviar(chat, f"↩️ Desfeito: {textos.e(x.get('resumo'))}.")
            else:  # já entrou no financeiro: o computador desfaz quando ligar
                _por_pendencia(pid, {"chat": chat, "ferramenta": "desfazer_bolso", "args": {"pid": dado[4:]}, "resumo": "Desfazer um lançamento"})
                await _enviar(chat, "Esse já entrou no financeiro. Desfaço assim que o computador ligar.")
            return
        if dado.startswith("c:"):
            b = (_ler(_pasta(pid) / "botoes.json", {}) or {}).get(dado[2:])
            if b:
                await _conversar(pid, chat, [{"text": b["texto"]}], b["texto"])
        return
    msg = upd.get("message") or upd.get("edited_message") or {}
    chat = msg.get("chat", {}).get("id")
    if not chat:
        return
    texto = (msg.get("text") or msg.get("caption") or "").strip()
    if texto.startswith("/"):
        cmd = texto.split()[0].split("@")[0].lower()
        if cmd in ("/start", "/ajuda", "/help"):
            await _enviar(chat, AJUDA)
            return
        if cmd == "/esquecer":
            _guardar_conversa(pid, str(chat), [])
            await _enviar(chat, "Conversa zerada. A memória e o financeiro continuam como estão.")
            return
        if cmd == "/mes":
            texto = "Me manda o relatório do financeiro deste mês."
        elif cmd == "/desfazer":
            x = tirar_pendencia(pid)
            await _enviar(chat, f"↩️ Desfeito: {textos.e(x.get('resumo'))}." if x else "Não há nada feito pelo celular para desfazer.")
            return
        elif cmd in COMANDOS:
            texto = COMANDOS[cmd]
    if msg.get("voice") or msg.get("audio"):
        a = msg.get("voice") or msg["audio"]
        dados = await _baixar(a["file_id"])
        await _conversar(pid, chat, [{"inlineData": {"mimeType": a.get("mime_type") or "audio/ogg", "data": base64.b64encode(dados).decode()}},
                                     {"text": "(Mensagem de áudio dele. Entenda e responda/aja como se ele tivesse falado.)" + (f" {texto}" if texto else "")}],
                         f"[áudio] {texto}".strip())
        return
    foto = max(msg["photo"], key=lambda x: x.get("file_size", 0)) if msg.get("photo") else None
    doc = msg.get("document")
    if doc and (doc.get("mime_type") or "").startswith("image/"):
        foto = doc
    if foto:
        dados = await _baixar(foto["file_id"])
        pedido = texto or "(Ele mandou esta foto. Se for nota fiscal, cupom, comprovante de Pix ou boleto, leia e proponha o lançamento; senão, descreva e pergunte o que ele quer.)"
        await _conversar(pid, chat, [{"inlineData": {"mimeType": foto.get("mime_type") or "image/jpeg", "data": base64.b64encode(dados).decode()}}, {"text": pedido}],
                         f"[foto] {texto}".strip(), comprovante=True)
        return
    if texto:
        await _conversar(pid, chat, [{"text": texto}], texto)


async def _digitando(chat: int, parar: asyncio.Event) -> None:
    while not parar.is_set():
        await _p().tg("sendChatAction", {"chat_id": chat, "action": "typing"})
        try:
            await asyncio.wait_for(parar.wait(), 4.5)
        except asyncio.TimeoutError:
            pass


async def _conversar(pid: str, chat: int, partes: list[dict[str, Any]], resumo: str, comprovante: bool = False) -> None:
    parar = asyncio.Event()
    tarefa = asyncio.create_task(_digitando(chat, parar))
    try:
        r = await responder(pid, chat, partes, resumo)
    finally:
        parar.set()
        await tarefa
    for m in r.mensagens:
        await _enviar(chat, m["texto"], m.get("teclado"))
    teclado = None
    if comprovante and not any(n == "lancar" for n, _ in r.ferramentas):
        teclado = _botoes(pid, [("Lançar", "Pode lançar como você propôs."), ("Editar", "Quero mudar algo antes de lançar."), ("Descartar", "Descarta, não lança.")])
    if r.texto or teclado:
        await _enviar(chat, _html(r.texto or "O que faço?"), teclado)


def documento_para_o_computador(upd: dict[str, Any]) -> bool:
    """Arquivo que não é imagem (extrato PDF/CSV/OFX): fica na fila para o computador ler e importar."""
    doc = (upd.get("message") or {}).get("document")
    return bool(doc) and not (doc.get("mime_type") or "").startswith("image/")


# ---------------------------------------------------------------- lembretes e avisos do dia


def _arquivo_lembretes() -> Path:
    return _p().DADOS / "lembretes.json"


def agendar(pid: str, chat: int | str, texto: str, em: float) -> None:
    f = _arquivo_lembretes()
    lista = json.loads(f.read_text()) if f.exists() else []
    lista.append({"id": secrets.token_hex(4), "perfil": pid, "chat": chat, "texto": texto, "em": em})
    f.write_text(json.dumps(lista, ensure_ascii=False))


async def lembretes_loop() -> None:
    while True:
        try:
            f = _arquivo_lembretes()
            lista = json.loads(f.read_text()) if f.exists() else []
            agora = time.time()
            vencidos = [x for x in lista if x["em"] <= agora]
            if vencidos:
                f.write_text(json.dumps([x for x in lista if x["em"] > agora], ensure_ascii=False))
                for x in vencidos:
                    await _enviar(x["chat"], f"⏰ <b>LEMBRETE</b>\n{textos.e(x['texto'])}")
        except Exception as exc:  # noqa: BLE001
            log.warning("lembretes: %s", exc)
        await asyncio.sleep(20)


async def avisos_loop() -> None:
    """Às 9h, com o computador desligado: o que vence hoje e amanhã (da cópia)."""
    while True:
        try:
            p = _p()
            pasta = p.DADOS / "bolso"
            for d in pasta.iterdir() if pasta.exists() else []:
                pid = d.name
                if p.conectado(pid) or not disponivel(pid):
                    continue
                c = copia(pid) or {}
                agora = dt.datetime.now(_fuso(c))
                feito = _ler(d / "avisos.json", {}) or {}
                if agora.hour < 9 or feito.get("dia") == agora.date().isoformat() or not c.get("chat"):
                    continue
                _gravar(d / "avisos.json", {"dia": agora.date().isoformat()})
                limite = (agora.date() + dt.timedelta(days=1)).isoformat()
                itens = [x for x in (c.get("financeiro") or {}).get("a_pagar") or [] if x.get("vence", "9999") <= limite]
                if not itens:
                    continue
                linhas = [f"{'🔴' if x['vence'] < agora.date().isoformat() else '⚠️'} {textos.e(x['titulo'])} · <b>{textos.brl(x['valor'])}</b> "
                          f"<i>{'vencida' if x['vence'] < agora.date().isoformat() else 'vence hoje' if x['vence'] == agora.date().isoformat() else 'vence amanhã'}</i>"
                          for x in itens[:8]]
                total = sum(textos.num(x["valor"]) for x in itens)
                await _enviar(c["chat"], f"{textos.titulo('⚠️', 'Contas vencendo')}\n<b>{textos.brl(total)}</b>\n{textos.SEP}\n" + "\n".join(linhas))
        except Exception as exc:  # noqa: BLE001
            log.warning("avisos do bolso: %s", exc)
        await asyncio.sleep(600)
