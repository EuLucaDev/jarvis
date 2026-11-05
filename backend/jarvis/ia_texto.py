"""IA de texto gratuita fora da Gemini, para o Telegram (computador e bolso): Groq (e Cerebras, se houver chave).

A Groq tem plano grátis rápido (~1 s) com chamada de ferramentas (`openai/gpt-oss-120b`) e transcrição de áudio
(Whisper). O limite que pesa é o de tokens por minuto (8.000 no grátis): por isso ela vai primeiro e, se estourar
ou falhar, o Telegram segue na Gemini como antes. Foto e PDF ficam na Gemini (estes modelos não leem imagem).

Formato OpenAI (chat/completions). As declarações de ferramentas do Jarvis (formato da Gemini: OBJECT, STRING…)
são convertidas por `ferramentas`. Sem dependências além do httpx (roda na portaria também).
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx

log = logging.getLogger("jarvis.ia_texto")

PROVEDORES = {
    "groq": {"url": "https://api.groq.com/openai/v1", "prefixo": "gsk_",
             "modelos": ["openai/gpt-oss-120b", "openai/gpt-oss-20b"], "whisper": "whisper-large-v3-turbo"},
    "cerebras": {"url": "https://api.cerebras.ai/v1", "prefixo": "csk-", "modelos": ["gpt-oss-120b", "qwen-3-235b-a22b-instruct-2507"]},
}
ESPERA = 15  # segundos por chamada
_pausados: dict[str, float] = {}  # "provedor:modelo" → até quando pular


def provedor(chave: str | None) -> str | None:
    chave = (chave or "").strip()
    return next((nome for nome, p in PROVEDORES.items() if chave.startswith(p["prefixo"])), None)


def _tipos(o: Any) -> Any:
    if isinstance(o, dict):
        return {k: (v.lower() if k == "type" and isinstance(v, str) else _tipos(v)) for k, v in o.items() if v is not None}
    if isinstance(o, list):
        return [_tipos(x) for x in o]
    return o


def ferramentas(decls: list[Any]) -> list[dict[str, Any]]:
    """Declarações da Gemini (objetos do SDK ou dicts) → ferramentas no formato OpenAI."""
    out = []
    for d in decls:
        if not isinstance(d, dict):
            d = d.model_dump(exclude_none=True)
        params = _tipos(d.get("parameters") or {"type": "object", "properties": {}})
        params.setdefault("properties", {})
        out.append({"type": "function", "function": {"name": d["name"], "description": (d.get("description") or "")[:1000], "parameters": params}})
    return out


async def conversar(http: httpx.AsyncClient, chave: str, sistema: str, mensagens: list[dict[str, Any]],
                    tools, executar, passos: int = 8) -> tuple[str, list[tuple[str, Any]]] | None:
    """Laço de ferramentas no formato OpenAI. `executar(nome, args)` roda a ferramenta (async) e devolve o resultado.
    `tools` pode ser uma função: é chamada a cada passo (ferramentas por assunto carregadas no meio da conversa).

    Devolve (texto final, [(ferramenta, resultado)]) ou None quando nenhum modelo respondeu (aí a Gemini assume).
    Se falhar no meio, depois de já ter rodado ferramentas, devolve o que tem (para não repetir registros na Gemini).
    """
    nome = provedor(chave)
    if not nome:
        return None
    p = PROVEDORES[nome]
    regra = ("\n\nREGRA DESTE CANAL: para lançar, registrar, consultar saldos, carteira ou qualquer número dele, CHAME a "
             "ferramenta e use o resultado. Nunca escreva você mesmo um cartão de \"registrado\" nem invente valores. Se a "
             "ferramenta pedir um dado que falta, pergunte só esse dado.")
    msgs = [{"role": "system", "content": sistema + regra}, *mensagens]
    feitas: list[tuple[str, Any]] = []
    tentou_de_novo: dict[str, bool] = {}
    for _ in range(passos):
        resposta = None
        for modelo in p["modelos"]:
            k = f"{nome}:{modelo}"
            if _pausados.get(k, 0) > time.time():
                continue
            try:
                r = await http.post(f"{p['url']}/chat/completions", headers={"Authorization": f"Bearer {chave}"}, timeout=ESPERA,
                                    json={"model": modelo, "messages": msgs, "tools": tools() if callable(tools) else tools, "temperature": 0.4})
            except Exception as exc:  # noqa: BLE001
                log.warning("%s %s: %s", nome, modelo, type(exc).__name__)
                _pausados[k] = time.time() + 120
                continue
            if r.status_code == 200:
                resposta = r.json()["choices"][0]["message"]
                break
            if r.status_code == 400 and "tool call validation failed" in r.text and not tentou_de_novo.get(k):
                tentou_de_novo[k] = True  # errou o nome de uma ferramenta: tenta mais uma vez o mesmo modelo
                try:
                    r = await http.post(f"{p['url']}/chat/completions", headers={"Authorization": f"Bearer {chave}"}, timeout=ESPERA,
                                        json={"model": modelo, "messages": msgs, "tools": tools() if callable(tools) else tools, "temperature": 0.2})
                    if r.status_code == 200:
                        resposta = r.json()["choices"][0]["message"]
                        break
                except Exception:  # noqa: BLE001
                    pass
            if r.status_code == 429:  # limite por minuto: o provedor diz quando volta
                try:
                    espera = float(r.headers.get("retry-after") or 60)
                except ValueError:
                    espera = 60.0
            elif r.status_code == 400:
                espera = 0.0  # pedido que este modelo não aceitou agora: não pausa
            else:
                espera = 600.0 if r.status_code in (401, 403, 404, 413) else 60.0
            _pausados[k] = time.time() + espera
            log.warning("%s %s: %s %s", nome, modelo, r.status_code, r.text[:160].replace("\n", " "))
        if resposta is None:
            return ("", feitas) if feitas else None
        chamadas = resposta.get("tool_calls") or []
        if not chamadas:
            return (resposta.get("content") or "").strip(), feitas
        msgs.append({"role": "assistant", "content": resposta.get("content") or "", "tool_calls": chamadas})
        for ch in chamadas:
            fn = ch.get("function") or {}
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            try:
                res = await executar(fn.get("name", ""), args if isinstance(args, dict) else {})
            except Exception as exc:  # noqa: BLE001
                res = {"erro": str(exc)[:300]}
            feitas.append((fn.get("name", ""), res))
            msgs.append({"role": "tool", "tool_call_id": ch.get("id"), "content": json.dumps(res, ensure_ascii=False, default=str)[:12000]})
    return "Fiz o que deu; diga se quer que eu continue.", feitas


async def transcrever(http: httpx.AsyncClient, chave: str, audio: bytes, mime: str = "audio/ogg") -> str | None:
    """Áudio do Telegram → texto (Whisper da Groq). None se não der."""
    if provedor(chave) != "groq" or not audio:
        return None
    try:
        r = await http.post(f"{PROVEDORES['groq']['url']}/audio/transcriptions", headers={"Authorization": f"Bearer {chave}"}, timeout=30,
                            files={"file": ("audio.ogg", audio, mime or "audio/ogg")}, data={"model": PROVEDORES["groq"]["whisper"], "language": "pt"})
        if r.status_code == 200:
            return (r.json().get("text") or "").strip() or None
        log.warning("whisper: %s %s", r.status_code, r.text[:160])
    except Exception as exc:  # noqa: BLE001
        log.warning("whisper: %s", type(exc).__name__)
    return None


async def conferir(http: httpx.AsyncClient, chave: str) -> bool:
    """A chave funciona? (lista de modelos do provedor)"""
    nome = provedor(chave)
    if not nome:
        return False
    try:
        r = await http.get(f"{PROVEDORES[nome]['url']}/models", headers={"Authorization": f"Bearer {chave}"}, timeout=10)
        return r.status_code == 200
    except Exception:  # noqa: BLE001
        return False


# Na reserva, só o essencial (o plano grátis da Groq tem 8.000 tokens por minuto): o dia a dia do financeiro, a carteira,
# memória e lembretes. O resto espera a Gemini voltar.
ESSENCIAIS = {
    "financeiro_lancar", "financeiro_consultar", "financeiro_transferir", "financeiro_lancamentos", "financeiro_desfazer",
    "financeiro_meta", "financeiro_fatura", "financeiro_pagar", "financeiro_competencia", "investimentos_carteira",
    "investimentos_registrar", "lembrar", "buscar_memorias", "criar_lembrete", "relatorio_financeiro", "meus_dados",
    # bolso
    "consultar", "lancamentos", "lancar", "transferir", "meta", "desfazer", "carteira_investimentos", "registrar_investimento",
    "pendentes", "pedido_para_o_computador", "cadastrar_conta",
}


def essenciais(decls: list[Any]) -> list[Any]:
    return [d for d in decls if (d.get("name") if isinstance(d, dict) else d.name) in ESSENCIAIS]


PROMPT_CURTO = """Você é J.A.R.V.I.S., assistente pessoal de {nome}, conversando pelo Telegram em português do Brasil: formal,
curto e preciso. Agora são {agora}.
- Dinheiro: use as ferramentas para lançar, consultar e registrar. Nunca invente valores nem diga que fez algo sem a
  ferramenta ter respondido ok. Faltou um dado essencial (valor, conta): pergunte só ele.
- Transferência entre contas dele não é gasto. Aporte não é rendimento.
- "Recebo no fim do mês para pagar o mês seguinte" → financeiro_competencia ligar (se existir).
- Respostas: uma ou duas frases; números com R$ 1.234,56. Os cartões que as ferramentas mandam já vão para ele: não repita.
{extra}"""


def prompt_curto(nome: str, agora: str, extra: str = "") -> str:
    return PROMPT_CURTO.format(nome=nome or "a pessoa", agora=agora, extra=extra)
