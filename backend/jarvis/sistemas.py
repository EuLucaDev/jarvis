"""Sistemas conectados: o Jarvis usa outros sistemas pela voz através do MCP (Model Context Protocol).

A pessoa cola, em Painel → Conexões → Sistemas, o endereço do MCP do sistema (ex.: o WorkFlow,
https://workflow.agcunae.com/api/mcp) e um token de acesso. O Jarvis lê as ações que o sistema oferece
(`tools/list`) e as entrega à Gemini como ferramentas `<sistema>__<ação>`; ao ser chamado, repassa (`tools/call`).

- O token fica só neste computador (tabela de ajustes, nunca volta para o navegador).
- Ação marcada como destrutiva pelo sistema (`destructiveHint`) ganha o campo `confirmado`: o Jarvis pergunta antes.
- Cada ação pode ser desligada no painel.
- Transporte HTTP do MCP (JSON ou SSE na resposta, com `Mcp-Session-Id` quando o servidor usa sessão).
"""

import json
import logging
import re
import time
import unicodedata
import uuid
from typing import Any

import httpx
from google.genai import types

from . import store

log = logging.getLogger("jarvis.sistemas")

PROTOCOLO = "2025-06-18"
_cache: dict[str, dict[str, Any]] = {}  # id do sistema → {"ferramentas": [...], "instrucoes": str, "sessao": str|None, "em": t}


class SistemaErro(Exception):
    pass


def _slug(nome: str) -> str:
    s = unicodedata.normalize("NFKD", nome.lower()).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")[:20] or "sistema"


def lista() -> list[dict[str, Any]]:
    return store.get("sistemas") or []


def publico() -> list[dict[str, Any]]:
    """Para o painel: sem o token."""
    out = []
    for s in lista():
        c = _cache.get(s["id"]) or {}
        out.append({**{k: v for k, v in s.items() if k != "token"}, "tem_token": bool(s.get("token")),
                    "acoes": [{"nome": f["name"], "titulo": f.get("title") or f["name"], "descricao": f.get("description", ""),
                               "destrutiva": bool((f.get("annotations") or {}).get("destructiveHint")),
                               "leitura": bool((f.get("annotations") or {}).get("readOnlyHint"))} for f in c.get("ferramentas", [])],
                    "erro": c.get("erro")})
    return out


def salvar(dados: dict[str, Any]) -> dict[str, Any]:
    itens = lista()
    sid = dados.get("id") or uuid.uuid4().hex[:8]
    atual = next((s for s in itens if s["id"] == sid), {})
    novo = {
        "id": sid,
        "nome": (dados.get("nome") or atual.get("nome") or "Sistema").strip()[:40],
        "url": (dados.get("url") or atual.get("url") or "").strip(),
        "token": dados.get("token") or atual.get("token") or "",
        "ativo": dados.get("ativo", atual.get("ativo", True)) is not False,
        "desligadas": dados.get("desligadas", atual.get("desligadas", [])),
        "prefixo": atual.get("prefixo") or _slug(dados.get("nome") or atual.get("nome") or "sistema"),
    }
    if not novo["url"].startswith(("https://", "http://127.0.0.1", "http://localhost")):
        raise SistemaErro("Use um endereço https:// (ou localhost para testes).")
    usados = {s["prefixo"] for s in itens if s["id"] != sid}
    while novo["prefixo"] in usados:
        novo["prefixo"] += "_2"
    store.put("sistemas", [s for s in itens if s["id"] != sid] + [novo])
    _cache.pop(sid, None)
    return novo


def remover(sid: str) -> None:
    store.put("sistemas", [s for s in lista() if s["id"] != sid])
    _cache.pop(sid, None)


# ---------- protocolo ----------


async def _rpc(sis: dict[str, Any], metodo: str, params: dict[str, Any] | None = None, sessao: str | None = None,
               prazo: float = 60) -> tuple[Any, str | None]:
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
               "MCP-Protocol-Version": PROTOCOLO}
    if sis.get("token"):
        headers["Authorization"] = f"Bearer {sis['token']}"
    if sessao:
        headers["Mcp-Session-Id"] = sessao
    corpo: dict[str, Any] = {"jsonrpc": "2.0", "method": metodo, "params": params or {}}
    if not metodo.startswith("notifications/"):  # aviso não leva id nem tem resposta
        corpo["id"] = uuid.uuid4().hex[:8]
    async with httpx.AsyncClient(timeout=prazo, follow_redirects=True) as c:
        r = await c.post(sis["url"], headers=headers, content=json.dumps(corpo, ensure_ascii=False))
    if r.status_code in (401, 403):
        raise SistemaErro("O sistema recusou o token (revogado ou sem permissão).")
    if r.status_code >= 400:
        raise SistemaErro(f"O sistema respondeu {r.status_code}.")
    nova_sessao = r.headers.get("mcp-session-id") or sessao
    if r.status_code == 202 or not r.content:
        return None, nova_sessao
    if "text/event-stream" in r.headers.get("content-type", ""):
        msg = None
        for linha in r.text.splitlines():
            if linha.startswith("data:"):
                try:
                    d = json.loads(linha[5:].strip())
                except ValueError:
                    continue
                if d.get("id") == corpo.get("id"):
                    msg = d
        if msg is None:
            raise SistemaErro("Resposta do sistema sem conteúdo.")
    else:
        msg = r.json()
    if msg.get("error"):
        raise SistemaErro(msg["error"].get("message") or "Erro no sistema.")
    return msg.get("result"), nova_sessao


async def carregar(sis: dict[str, Any], forcar: bool = False) -> dict[str, Any]:
    """Conecta e lê as ações (guarda por 10 min)."""
    c = _cache.get(sis["id"])
    if c and not forcar and not c.get("erro") and time.time() - c["em"] < 600:
        return c
    try:
        # prazo curto: com o sistema fora do ar, a conversa começa sem ele em vez de esperar
        init, sessao = await _rpc(sis, "initialize", {"protocolVersion": PROTOCOLO, "capabilities": {},
                                                      "clientInfo": {"name": "jarvis", "version": "2"}}, prazo=8)
        try:
            await _rpc(sis, "notifications/initialized", {}, sessao, prazo=8)
        except SistemaErro:
            pass  # servidores sem sessão respondem 202 sem corpo
        ferramentas: list[dict[str, Any]] = []
        cursor = None
        for _ in range(10):
            res, sessao = await _rpc(sis, "tools/list", {"cursor": cursor} if cursor else {}, sessao, prazo=8)
            ferramentas += res.get("tools") or []
            cursor = res.get("nextCursor")
            if not cursor:
                break
        c = {"ferramentas": ferramentas, "instrucoes": (init or {}).get("instructions") or "", "sessao": sessao, "em": time.time(),
             "servidor": ((init or {}).get("serverInfo") or {}).get("title") or ((init or {}).get("serverInfo") or {}).get("name")}
    except (SistemaErro, httpx.HTTPError, ValueError) as exc:
        c = {"ferramentas": [], "instrucoes": "", "sessao": None, "em": time.time(), "erro": str(exc)[:200]}
        log.warning("sistema %s: %s", sis.get("nome"), exc)
    _cache[sis["id"]] = c
    return c


async def carregar_todos() -> None:
    for s in lista():
        if s.get("ativo", True):
            await carregar(s)


def _declaracao(sis: dict[str, Any], f: dict[str, Any]) -> types.FunctionDeclaration:
    schema = json.loads(json.dumps(f.get("inputSchema") or {"type": "object", "properties": {}}))
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})
    destrutiva = bool((f.get("annotations") or {}).get("destructiveHint"))
    desc = f"[{sis['nome']}] {f.get('description') or f.get('title') or f['name']}"
    if destrutiva:
        schema["properties"]["confirmado"] = {"type": "boolean", "description": "true só depois do sim da pessoa."}
        desc += " Ação que apaga ou mexe em algo importante: chame sem confirmado, diga o que vai fazer e repita com confirmado=true depois do sim."
    nome = f"{sis['prefixo']}__{re.sub(r'[^a-zA-Z0-9_]', '_', f['name'])}"[:64]
    return types.FunctionDeclaration(name=nome, description=desc[:1000], parameters_json_schema=schema)


def declaracoes_de(s: dict[str, Any]) -> list[types.FunctionDeclaration]:
    return [_declaracao(s, f) for f in (_cache.get(s["id"]) or {}).get("ferramentas", []) if f["name"] not in (s.get("desligadas") or [])]


def declaracoes() -> list[types.FunctionDeclaration]:
    """Ferramentas de todos os sistemas ativos (do que já foi carregado)."""
    out = []
    for s in lista():
        if not s.get("ativo", True):
            continue
        for f in (_cache.get(s["id"]) or {}).get("ferramentas", []):
            if f["name"] not in (s.get("desligadas") or []):
                out.append(_declaracao(s, f))
    return out


def prompt_bloco() -> str:
    linhas = []
    for s in lista():
        c = _cache.get(s["id"]) or {}
        if s.get("ativo", True) and c.get("ferramentas"):
            linhas.append(f"- {s['nome']} (ferramentas {s['prefixo']}__*): {c.get('instrucoes') or 'sistema da pessoa.'}")
    if not linhas:
        return ""
    return ("Sistemas da pessoa conectados (use as ferramentas deles quando ela pedir algo desses sistemas; "
            "mostre listas e números num cartão com mostrar_lista ou mostrar_pesquisa):\n" + "\n".join(linhas))


def e_do_sistema(nome: str) -> bool:
    return "__" in nome and any(nome.startswith(s["prefixo"] + "__") for s in lista())


async def executar(nome: str, args: dict[str, Any]) -> dict[str, Any]:
    sis = next((s for s in lista() if nome.startswith(s["prefixo"] + "__")), None)
    if not sis:
        return {"erro": "Sistema não encontrado."}
    c = await carregar(sis)
    acao = next((f for f in c.get("ferramentas", []) if f"{sis['prefixo']}__{re.sub(r'[^a-zA-Z0-9_]', '_', f['name'])}"[:64] == nome), None)
    if not acao:
        return {"erro": "Essa ação não existe mais no sistema."}
    args = dict(args or {})
    confirmado = bool(args.pop("confirmado", False))
    if (acao.get("annotations") or {}).get("destructiveHint") and not confirmado:
        return {"precisa_confirmar": True, "acao": acao.get("title") or acao["name"], "argumentos": args,
                "instrucao": f"Diga em uma frase o que vai fazer no {sis['nome']} e pergunte se pode. Só repita com confirmado=true depois do sim."}
    try:
        res, sessao = await _rpc(sis, "tools/call", {"name": acao["name"], "arguments": args}, c.get("sessao"))
    except SistemaErro as exc:
        if c.get("sessao"):  # sessão expirou: reconecta uma vez
            c = await carregar(sis, forcar=True)
            res, sessao = await _rpc(sis, "tools/call", {"name": acao["name"], "arguments": args}, c.get("sessao"))
        else:
            return {"erro": str(exc)}
    texto = "\n".join(p.get("text", "") for p in (res or {}).get("content", []) if p.get("type") == "text")
    if (res or {}).get("isError"):
        return {"erro": texto or "O sistema não conseguiu fazer isso."}
    try:
        dados: Any = json.loads(texto)
    except ValueError:
        dados = texto
    if res.get("structuredContent") is not None:
        dados = res["structuredContent"]
    return {"ok": True, "sistema": sis["nome"], "resultado": dados}
