"""O Jarvis por texto (Telegram): a mesma pessoa, as mesmas ferramentas, sem voz ao vivo e sem mexer no computador.

Usa a Gemini de texto (generate_content) com chamada de ferramentas em laço: o modelo pede ferramentas, elas rodam
pelo mesmo `tools.run` da voz, o resultado volta e ele continua até responder. Áudio, foto e PDF entram direto
como partes da mensagem (a Gemini entende os três).

- Ferramentas permitidas fora do computador (`PERMITIDAS`): memória, pesquisa, clima, mercado, cartões, financeiro
  (o do dia a dia e o completo por assunto), os sistemas MCP (WorkFlow) e o carregamento por assunto. Nada de
  janelas, cliques, teclado, arquivos do computador ou tela.
- `carregar_assunto` aqui é instantâneo: o próximo passo do laço já vem com as ferramentas do assunto.
- Cartões que as ferramentas mostram ficam numa lista (hub.coletor) e viram imagem na conversa.
- Conversa guardada por chat (últimas mensagens), para ele lembrar do que acabou de ser dito.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from google.genai import types

from . import store, tools
from .config import settings
from .hub import coletor

log = logging.getLogger("jarvis.agente")

PASSOS = 10
HISTORICO = 16
PERMITIDAS = {
    "mostrar_pesquisa", "consultar_clima", "mostrar_lista", "lembrar", "buscar_memorias", "esquecer",
    "consultar_mercado", "pesquisar_web", "carregar_assunto", "consultar_tarefas", "onde_parei",
}
SEM = {"financeiro_abrir"}  # abre janela no computador


@dataclass
class Resposta:
    texto: str = ""
    cartoes: list[dict[str, Any]] = field(default_factory=list)
    anexos: list[tuple[str, bytes, str]] = field(default_factory=list)  # (nome, bytes, tipo: imagem|documento)
    ferramentas: list[tuple[str, dict[str, Any]]] = field(default_factory=list)  # (nome, resultado)

    def usou(self, nome: str) -> dict[str, Any] | None:
        return next((r for n, r in self.ferramentas if n == nome), None)


LEMBRETE_DECL = types.FunctionDeclaration(
    name="criar_lembrete",
    description="Agenda um lembrete: na hora, você manda a mensagem para ele aqui no Telegram. Ex.: 'me lembra amanhã às 9h de pagar o boleto'.",
    parameters={"type": "OBJECT", "properties": {
        "texto": {"type": "STRING"},
        "quando": {"type": "STRING", "description": "Data e hora ISO local, ex.: 2026-10-31T09:00."}},
        "required": ["texto", "quando"]},
)
PERFIL_DECL = types.FunctionDeclaration(
    name="meus_dados",
    description="Guarda como ele quer ser chamado e os dados básicos: nome, tratamento (Senhor, Senhora ou vazio para chamar pelo nome) e cidade.",
    parameters={"type": "OBJECT", "properties": {"nome": {"type": "STRING"}, "tratamento": {"type": "STRING"}, "cidade": {"type": "STRING"}}},
)
RELATORIO_DECL = types.FunctionDeclaration(
    name="relatorio_financeiro",
    description=(
        "Monta o relatório do financeiro de um mês, diagramado no visual do Jarvis, e manda na conversa: imagem "
        "(um cartão com totais, gráfico e categorias), pdf (documento completo de várias páginas) ou os dois."
    ),
    parameters={"type": "OBJECT", "properties": {
        "mes": {"type": "STRING", "description": "AAAA-MM; sem dizer, o mês atual."},
        "formato": {"type": "STRING", "enum": ["imagem", "pdf", "ambos"]}}},
)


def _declaracoes(assuntos: set[str]) -> list[types.Tool]:
    decls = []
    for d in tools.todas(assuntos)[-1].function_declarations or []:
        n = d.name or ""
        if n in SEM:
            continue
        if n in PERMITIDAS or n.startswith(("financeiro_", "fin_")) or "__" in n:
            # "não bloquear" (behavior) só existe na voz ao vivo; no texto a Gemini recusa a ferramenta inteira
            decls.append(d.model_copy(update={"behavior": None}) if getattr(d, "behavior", None) else d)
    return [types.Tool(function_declarations=[*decls, LEMBRETE_DECL, RELATORIO_DECL, PERFIL_DECL])]


def _prompt(nome_canal: str) -> str:
    hoje = time.strftime("%A, %d/%m/%Y, %H:%M")
    nome, chamar = settings.user_name, settings.chamar
    trato = f'Chame a pessoa de "{chamar}".' if chamar != nome else f"Chame a pessoa pelo nome, {nome}."
    assuntos = "; ".join(f"{k} = {v}" for k, v in tools.assuntos_disponiveis().items())
    return f"""Você é J.A.R.V.I.S., o assistente pessoal de {nome}. {trato} Agora vocês conversam pelo {nome_canal}.
Português do Brasil. Seu jeito é o do J.A.R.V.I.S. dos filmes: formal sem ser frio, confiante, curto e preciso,
uma ironia leve de vez em quando (nunca em assunto sério). Agora são {hoje}. Cidade padrão: {settings.city}.

Como responder no {nome_canal}:
- Mensagens curtas e bem organizadas. Use **negrito** para valores e nomes importantes, listas com "•", uma ideia
  por linha. Nada de tabelas. Valores sempre em reais (R$ 1.234,56).
- Cartões que as ferramentas mostram chegam como imagem junto da sua mensagem: não repita tudo o que está neles.
- Relatório do mês, fechamento, "me manda o relatório": relatorio_financeiro (imagem; pdf se ele pedir documento).

O que você faz aqui: financeiro, os sistemas dele (WorkFlow), memória, pesquisa, clima, mercado e lembretes.
Você NÃO mexe no computador por aqui (abrir apps, clicar, arquivos, tela): se ele pedir, diga que isso é no
notebook.

Ferramentas por assunto: antes de usar ferramentas de um assunto que ainda não estão disponíveis, chame
carregar_assunto (é instantâneo). Assuntos: {assuntos}.
- Dinheiro pessoal do dia a dia: financeiro_* (lançar, fixas, consultar, faturas…). O resto do financeiro está nos
  assuntos "financeiro_*" (cadastros, lançamentos a fundo, investimentos, planejamento, relatórios, dados).
- Áudio: entenda o que ele disse e aja (ex.: "gastei 80 no mercado no crédito do Nubank em 2x" → financeiro_lancar).
- Foto ou PDF de nota fiscal, cupom, comprovante de Pix ou boleto: leia valor, data, estabelecimento e forma de
  pagamento, sugira a categoria e mostre o lançamento proposto; pergunte se pode lançar e só lance depois do sim.
- Apagar, pagar, importar, zerar ou mexer em muitos itens: diga exatamente o que vai acontecer e espere o sim
  (as ferramentas pedem confirmado=true).
- Não invente números: use as ferramentas. Nunca peça nem repita senhas ou dados completos de cartão.
- NUNCA diga que guardou, lançou, criou, apagou, agendou ou fez qualquer coisa sem ter chamado a ferramenta
  nesta mesma resposta e recebido ok. "Guarda/lembra que…" → lembrar. "Me lembra de…" → criar_lembrete.
"""


def _historico(chave: str) -> list[types.Content]:
    linhas = (store.get(f"conversa:{chave}") or {}).get("linhas", [])
    return [types.Content(role=l["papel"], parts=[types.Part(text=l["texto"])]) for l in linhas[-HISTORICO:]]


def _guardar(chave: str, usuario: str, resposta: str) -> None:
    atual = (store.get(f"conversa:{chave}") or {}).get("linhas", [])
    atual += [{"papel": "user", "texto": usuario[:2000]}, {"papel": "model", "texto": resposta[:2000]}]
    store.put(f"conversa:{chave}", {"linhas": atual[-HISTORICO:], "em": time.time()})


def esquecer_conversa(chave: str) -> None:
    store.put(f"conversa:{chave}", {"linhas": []})


async def _ferramenta(nome: str, args: dict[str, Any], assuntos: set[str], resp: Resposta, chave: str) -> dict[str, Any]:
    if nome == "carregar_assunto":
        a = str(args.get("assunto", ""))
        if a not in tools.assuntos_disponiveis():
            return {"erro": f"Assunto desconhecido: {a}."}
        assuntos.add(a)
        return {"ok": True, "instrucao": "Carregado. Use as ferramentas do assunto agora, sem comentar."}
    if nome == "criar_lembrete":
        from . import telegram

        return telegram.agendar_lembrete(chave, str(args.get("texto", "")), str(args.get("quando", "")))
    if nome == "meus_dados":
        campos = {k2: str(args[k]).strip() for k, k2 in (("nome", "user_name"), ("tratamento", "tratamento"), ("cidade", "city")) if k in args}
        settings.update(**campos)
        return {"ok": True, "guardado": campos, "instrucao": "Confirme numa frase, já usando o novo jeito de chamar."}
    if nome == "relatorio_financeiro":
        from . import impressao

        try:
            arquivos = await impressao.relatorio(args.get("mes") or time.strftime("%Y-%m"), args.get("formato") or "imagem")
        except Exception as exc:  # noqa: BLE001
            log.warning("relatório falhou: %s", exc)
            return {"erro": f"Não consegui montar o relatório ({str(exc)[:120]})."}
        resp.anexos += arquivos
        return {"ok": True, "enviado": [n for n, _, _ in arquivos], "instrucao": "O relatório vai junto. Comente em uma ou duas frases o principal."}
    if nome not in PERMITIDAS and not nome.startswith(("financeiro_", "fin_")) and "__" not in nome:
        return {"erro": "Isso não está disponível por aqui."}
    return await tools.run(nome, args)


def _limpo(r: Any) -> Any:
    """Resultado de ferramenta em JSON simples (a Gemini não aceita bytes nem objetos)."""
    try:
        return json.loads(json.dumps(r, ensure_ascii=False, default=str))
    except Exception:  # noqa: BLE001
        return {"resultado": str(r)[:4000]}


async def responder(chave: str, partes: list[types.Part], resumo_usuario: str, canal: str = "Telegram") -> Resposta:
    """Uma mensagem dele (texto, áudio, imagem…) → a resposta do Jarvis, com cartões e anexos."""
    from .llm import FALLBACK, client

    c = client()
    resp = Resposta()
    if not c:
        resp.texto = "Ainda não tenho a chave da Gemini neste Jarvis. Configure no notebook (Painel → Nuvem e Telegram)."
        return resp
    assuntos: set[str] = set()
    contents = [*_historico(chave), types.Content(role="user", parts=partes)]
    cartoes: list[dict[str, Any]] = []
    token = coletor.set(cartoes)
    modelos = [settings.text_model, "gemini-3.5-flash", FALLBACK]
    try:
        for _ in range(PASSOS):
            r = None
            for m in modelos:
                try:
                    r = await c.aio.models.generate_content(
                        model=m, contents=contents,
                        config=types.GenerateContentConfig(system_instruction=_prompt(canal), tools=_declaracoes(assuntos),
                                                           automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True)))
                    break
                except Exception as exc:  # noqa: BLE001
                    log.warning("%s falhou: %s", m, str(exc)[:160])
                    modelos = [x for x in modelos if x != m] or [FALLBACK]
            if r is None or not r.candidates:
                resp.texto = "Os modelos da Gemini não responderam agora. Tente de novo em um minuto."
                break
            conteudo = r.candidates[0].content or types.Content(role="model", parts=[])
            chamadas = [p.function_call for p in (conteudo.parts or []) if p.function_call]
            if not chamadas:
                resp.texto = "".join(p.text or "" for p in (conteudo.parts or []) if p.text and not getattr(p, "thought", False)).strip()
                break
            contents.append(conteudo)
            respostas = []
            for fc in chamadas:
                args = dict(fc.args or {})
                try:
                    res = await _ferramenta(fc.name, args, assuntos, resp, chave)
                except Exception as exc:  # noqa: BLE001
                    log.warning("ferramenta %s: %s", fc.name, exc)
                    res = {"erro": str(exc)[:300]}
                res = _limpo(res if isinstance(res, dict) else {"resultado": res})
                res.pop("_imagem", None)
                resp.ferramentas.append((fc.name, res))
                respostas.append(types.Part(function_response=types.FunctionResponse(id=fc.id, name=fc.name, response=res)))
            contents.append(types.Content(role="user", parts=respostas))
        else:
            resp.texto = resp.texto or "Fiz o que deu; diga se quer que eu continue."
    finally:
        coletor.reset(token)
    resp.cartoes = cartoes
    if not resp.texto and (resp.cartoes or resp.anexos):
        resp.texto = "Pronto."
    _guardar(chave, resumo_usuario, resp.texto)
    return resp


async def texto(chave: str, mensagem: str) -> Resposta:
    return await responder(chave, [types.Part(text=mensagem)], mensagem)
