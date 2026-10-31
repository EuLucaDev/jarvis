"""O Jarvis no Telegram, rodando no computador da pessoa.

A portaria (VPS) recebe as mensagens do robô e entrega aqui, pela ponte (nuvem.py), só as da conta deste computador.
As respostas voltam pela portaria (/api/ponte/tg/...), que guarda o token do robô e só deixa responder nas conversas
da própria conta. Financeiro, memória e conversa ficam neste computador.

- Texto, áudio (a Gemini ouve direto), foto (nota fiscal, cupom, Pix) e documento (extrato PDF/CSV/OFX → prévia da
  importação; outro PDF → a Gemini lê).
- Respostas em HTML do Telegram, com botões: Confirmar/Cancelar quando uma ferramenta pede o sim, Desfazer depois de
  um lançamento, Lançar/Descartar para comprovantes, Importar/Cancelar para extratos.
- Tudo em texto diagramado (textos.py): cartões das ferramentas e o relatório do mês viram mensagens com valores
  alinhados e barras de caracteres. Nenhuma imagem é gerada.
- Lembretes agendados e avisos (contas, orçamento, sistemas) chegam aqui quando a pessoa não está na frente do
  computador (presença pela câmera).
- Comandos: /hoje, /mes, /contas, /desfazer, /esquecer, /ajuda.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import html
import json
import logging
import os
import re
import time
import uuid
from typing import Any

import httpx
from google.genai import types

from . import store

log = logging.getLogger("jarvis.telegram")

TOKEN_DIRETO = os.getenv("JARVIS_TELEGRAM_TOKEN", "")  # sem portaria (desenvolvimento): fala direto com o Telegram
LIMITE = 3900

AJUDA = (
    "<b>Jarvis</b> · o mesmo do seu computador, por aqui.\n\n"
    "• Escreva ou mande <b>áudio</b>: \"gastei 80 no mercado no crédito do Nubank em 2x\"\n"
    "• Mande <b>foto</b> de nota fiscal, cupom ou comprovante de Pix: eu leio e proponho o lançamento\n"
    "• Mande o <b>extrato</b> (PDF, CSV ou OFX): eu mostro o que vou importar\n"
    "• Peça o <b>relatório do mês</b>, metas, faturas, investimentos, tarefas do WorkFlow\n"
    "• \"Me lembra amanhã às 9h de pagar o boleto\"\n\n"
    "/hoje · resumo do dia\n/mes · relatório do mês\n/contas · o que vence\n/desfazer · desfaz o último lançamento\n"
    "/esquecer · começa a conversa do zero"
)
COMANDOS = {
    "/hoje": "Me dê o resumo de hoje: saldo, o que vence nos próximos dias, orçamento apertado e, se houver, minhas tarefas de hoje no WorkFlow.",
    "/mes": "Me manda o relatório do financeiro deste mês.",
    "/contas": "O que vence nos próximos 7 dias?",
    "/desfazer": "Desfaz o último lançamento que você fez.",
}


# ---------------------------------------------------------------- falar com o Telegram


async def api(metodo: str, dados: dict[str, Any] | None = None, arquivos: dict[str, tuple[str, bytes, str]] | None = None) -> dict[str, Any]:
    """Chama a API do robô (pela portaria, que tem o token)."""
    from . import nuvem

    if TOKEN_DIRETO:
        url, headers = f"https://api.telegram.org/bot{TOKEN_DIRETO}/{metodo}", {}
    elif nuvem.ligado():
        url, headers = nuvem.url(f"/api/ponte/tg/{metodo}"), nuvem.cabecalho()
    else:
        raise RuntimeError("Jarvis sem conta: entre pelo Jarvis Launcher")
    async with httpx.AsyncClient(timeout=60) as c:
        if arquivos:
            campos = {k: (json.dumps(v) if isinstance(v, (dict, list)) else str(v)) for k, v in (dados or {}).items()}
            r = await c.post(url, data=campos, files=arquivos, headers=headers)
        else:
            r = await c.post(url, json=dados or {}, headers=headers)
    corpo = r.json() if r.content else {}
    if not corpo.get("ok"):
        log.warning("telegram %s: %s", metodo, str(corpo)[:200])
    return corpo


async def baixar(file_id: str) -> bytes:
    if TOKEN_DIRETO:
        info = await api("getFile", {"file_id": file_id})
        caminho = info["result"]["file_path"]
        async with httpx.AsyncClient(timeout=60) as c:
            return (await c.get(f"https://api.telegram.org/file/bot{TOKEN_DIRETO}/{caminho}")).content
    from . import nuvem

    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.get(nuvem.url("/api/ponte/tg-arquivo"), params={"file_id": file_id}, headers=nuvem.cabecalho())
        r.raise_for_status()
        return r.content


def html_de(texto: str) -> str:
    """Markdown simples da Gemini → HTML do Telegram (negrito, itálico, código, links), com o resto escapado."""
    t = html.escape(texto or "", quote=False)
    t = re.sub(r"```(?:\w+)?\n?(.*?)```", lambda m: f"<pre>{m.group(1).strip()}</pre>", t, flags=re.S)
    t = re.sub(r"`([^`\n]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<![\w*])\*(?!\s)([^*\n]+?)\*(?!\w)", r"<i>\1</i>", t)
    t = re.sub(r"(?<!\w)_(?!\s)([^_\n]+?)_(?!\w)", r"<i>\1</i>", t)
    t = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', t)
    t = re.sub(r"^#{1,6}\s*(.+)$", r"<b>\1</b>", t, flags=re.M)
    t = re.sub(r"^\s*[-*]\s+", "• ", t, flags=re.M)
    return t.strip()


# botões que fazem a ação direto (sem depender do modelo entender): "!<ação>"
ACOES_DIRETAS = {
    "!importar": ("financeiro_importar", {"confirmado": True}),
    "!desfazer": ("financeiro_desfazer", {}),
}


def _teclado(botoes: list[tuple[str, str]]) -> dict[str, Any] | None:
    """[(rótulo, o que ele "diz" ao tocar, ou "!ação")] → teclado embutido (o texto fica guardado aqui; o botão só leva o id)."""
    if not botoes:
        return None
    mapa = store.get("tg_botoes") or {}
    linha = []
    for rotulo, texto in botoes:
        k = uuid.uuid4().hex[:10]
        mapa[k] = {"texto": texto, "em": time.time()}
        linha.append({"text": rotulo, "callback_data": f"b:{k}"})
    if len(mapa) > 300:
        mapa = dict(sorted(mapa.items(), key=lambda kv: kv[1]["em"])[-300:])
    store.put("tg_botoes", mapa)
    return {"inline_keyboard": [linha]}


async def enviar(chat: int | str, texto: str, botoes: list[tuple[str, str]] | None = None, pronto: bool = False) -> None:
    """Manda uma mensagem (em partes, se for longa). pronto=True: o texto já está em HTML do Telegram."""
    partes = [texto[i:i + LIMITE] for i in range(0, len(texto), LIMITE)] or [""]
    for n, p in enumerate(partes):
        dados: dict[str, Any] = {"chat_id": chat, "text": p if pronto else html_de(p), "parse_mode": "HTML", "disable_web_page_preview": True}
        if n == len(partes) - 1 and botoes:
            dados["reply_markup"] = _teclado(botoes)
        r = await api("sendMessage", dados)
        if not r.get("ok"):  # HTML que o Telegram não aceitou: vai como texto simples
            dados.pop("parse_mode")
            dados["text"] = p
            await api("sendMessage", dados)


async def _digitando(chat: int | str, parar: asyncio.Event) -> None:
    while not parar.is_set():
        await api("sendChatAction", {"chat_id": chat, "action": "typing"})
        try:
            await asyncio.wait_for(parar.wait(), 4.5)
        except asyncio.TimeoutError:
            pass


# ---------------------------------------------------------------- receber


def _chat_principal(chat: int | str) -> None:
    t = store.get("telegram") or {}
    if t.get("chat") != chat:
        store.put("telegram", {**t, "chat": chat})


async def tratar(update: dict[str, Any]) -> None:
    """Uma atualização do Telegram (mensagem ou toque num botão) deste perfil."""
    if "callback_query" in update:
        cq = update["callback_query"]
        chat = cq["message"]["chat"]["id"]
        await api("answerCallbackQuery", {"callback_query_id": cq["id"]})
        await api("editMessageReplyMarkup", {"chat_id": chat, "message_id": cq["message"]["message_id"], "reply_markup": {"inline_keyboard": []}})
        k = (cq.get("data") or "").removeprefix("b:")
        b = (store.get("tg_botoes") or {}).get(k)
        if b and b["texto"] in ACOES_DIRETAS:
            await _acao_direta(chat, b["texto"])
        elif b:
            await _conversar(chat, [types.Part(text=b["texto"])], b["texto"])
        return
    msg = update.get("message") or update.get("edited_message")
    if not msg:
        return
    chat = msg["chat"]["id"]
    _chat_principal(chat)
    texto = (msg.get("text") or msg.get("caption") or "").strip()
    if texto.startswith("/"):
        cmd = texto.split()[0].split("@")[0].lower()
        if cmd in ("/start", "/ajuda", "/help"):
            await enviar(chat, AJUDA, pronto=True)
            return
        if cmd == "/esquecer":
            from . import agente

            agente.esquecer_conversa(str(chat))
            await enviar(chat, "Conversa zerada. A memória e o financeiro continuam como estão.")
            return
        if cmd in COMANDOS:
            await _conversar(chat, [types.Part(text=COMANDOS[cmd])], COMANDOS[cmd])
            return
    if msg.get("voice") or msg.get("audio"):
        a = msg.get("voice") or msg["audio"]
        dados = await baixar(a["file_id"])
        mime = a.get("mime_type") or "audio/ogg"
        partes = [types.Part.from_bytes(data=dados, mime_type=mime),
                  types.Part(text="(Mensagem de áudio dele. Entenda e responda/aja como se ele tivesse falado.)" + (f" {texto}" if texto else ""))]
        await _conversar(chat, partes, f"[áudio] {texto}".strip())
        return
    if msg.get("photo"):
        foto = max(msg["photo"], key=lambda p: p.get("file_size", 0))
        dados = await baixar(foto["file_id"])
        pedido = texto or ("(Ele mandou esta foto. Se for nota fiscal, cupom, comprovante de Pix ou boleto, leia e proponha o "
                           "lançamento; senão, descreva e pergunte o que ele quer.)")
        await _conversar(chat, [types.Part.from_bytes(data=dados, mime_type="image/jpeg"), types.Part(text=pedido)],
                         f"[foto] {texto}".strip(), comprovante=True)
        return
    if msg.get("document"):
        await _documento(chat, msg["document"], texto)
        return
    if texto:
        await _conversar(chat, [types.Part(text=texto)], texto)


async def _acao_direta(chat: int | str, acao: str) -> None:
    from . import tools
    from .hub import coletor

    nome, args = ACOES_DIRETAS[acao]
    cartoes: list[dict[str, Any]] = []
    token = coletor.set(cartoes)
    try:
        res = await tools.run(nome, dict(args))
    finally:
        coletor.reset(token)
    if res.get("erro"):
        await enviar(chat, res["erro"])
        return
    if acao == "!importar":
        rel = res.get("importado") or {}
        n = sum(rel.get(k, 0) for k in ("expenses", "incomes", "contributions", "withdrawals", "invoicePayments")) if isinstance(rel, dict) else None
        texto = f"Importado. {n} lançamentos entraram no financeiro." if n is not None else "Importado para o financeiro."
        if isinstance(rel, dict) and rel.get("skipped"):
            texto += f" {rel['skipped']} repetidos ficaram de fora."
    else:
        texto = "Desfeito."
    from . import agente

    await _entregar(chat, agente.Resposta(texto=texto, cartoes=cartoes))


async def _documento(chat: int | str, doc: dict[str, Any], texto: str) -> None:
    nome = doc.get("file_name") or "arquivo"
    mime = doc.get("mime_type") or ""
    if (doc.get("file_size") or 0) > 20 * 1024 * 1024:
        await enviar(chat, "Esse arquivo passa de 20 MB, o limite do Telegram para robôs. Mande em partes ou pelo notebook.")
        return
    dados = await baixar(doc["file_id"])
    ext = os.path.splitext(nome)[1].lower()
    if ext in (".pdf", ".csv", ".ofx", ".txt") and not texto:
        prev = await _previa_extrato(nome, dados)
        if prev:
            await enviar(chat, prev, [("Importar", "!importar"), ("Cancelar", "Não importa esse extrato.")], pronto=True)
            return
    if mime.startswith("image/"):
        await _conversar(chat, [types.Part.from_bytes(data=dados, mime_type=mime), types.Part(text=texto or "(Foto mandada como arquivo.)")],
                         f"[foto] {texto}".strip(), comprovante=True)
        return
    if ext == ".pdf":
        await _conversar(chat, [types.Part.from_bytes(data=dados, mime_type="application/pdf"),
                                types.Part(text=texto or "(Ele mandou este PDF. Se for nota fiscal, boleto ou comprovante, proponha o lançamento.)")],
                         f"[pdf {nome}] {texto}".strip(), comprovante=True)
        return
    await enviar(chat, f"Recebi <b>{html.escape(nome)}</b>, mas não sei ler esse tipo de arquivo. Mande PDF, CSV, OFX ou foto.", pronto=True)


async def _previa_extrato(nome: str, dados: bytes) -> str | None:
    """Extrato ou fatura reconhecido pelos leitores do financeiro → texto da prévia (e a importação fica pronta)."""
    from . import finance, finance_voz

    caminho = finance.guardar_entrada(nome, dados)
    try:
        sessao = await finance.chamar("import:readBatch", [caminho], {})
    except Exception as exc:  # noqa: BLE001
        log.info("não é extrato (%s): %s", nome, exc)
        return None
    docs = [d for d in sessao.get("documents") or [] if d.get("total")]
    if not docs:
        return None
    alvos = await finance.chamar("import:suggestTargets", sessao)
    finance_voz._importacao = {"sessao": sessao, "alvos": alvos}  # noqa: SLF001 - "Importar" confirma pela ferramenta de sempre
    linhas = [f"• <b>{html.escape(str(d.get('bank') or 'banco não reconhecido'))}</b> · {html.escape(str(d.get('documentType') or ''))} · "
              f"{d.get('total')} lançamentos" for d in docs]
    periodo = sessao.get("period") or {}
    quando = f"\nPeríodo: {periodo.get('start', '')} a {periodo.get('end', '')}" if periodo.get("start") else ""
    return "<b>Extrato lido</b>\n" + "\n".join(linhas) + quando + "\n\nImporto para o financeiro? Repetidos ficam de fora."


async def _conversar(chat: int | str, partes: list[types.Part], resumo: str, comprovante: bool = False) -> None:
    from . import agente

    parar = asyncio.Event()
    tarefa = asyncio.create_task(_digitando(chat, parar))
    try:
        r = await agente.responder(str(chat), partes, resumo)
    except Exception as exc:  # noqa: BLE001
        log.exception("conversa falhou")
        r = agente.Resposta(texto=f"Algo deu errado aqui: {str(exc)[:160]}")
    finally:
        parar.set()
        await tarefa
    await _entregar(chat, r, comprovante)


def _botoes(r, comprovante: bool) -> list[tuple[str, str]]:
    nomes = [n for n, _ in r.ferramentas]
    if any(isinstance(x, dict) and x.get("precisa_confirmar") for _, x in r.ferramentas):
        return [("Confirmar", "Sim, confirmo."), ("Cancelar", "Não, cancela.")]
    lancou = any(n in ("financeiro_lancar", "financeiro_transferir") and isinstance(x, dict) and x.get("ok") for n, x in r.ferramentas)
    if lancou:
        return [("Desfazer", "!desfazer")]
    if comprovante and "financeiro_lancar" not in nomes:
        return [("Lançar", "Pode lançar como você propôs."), ("Editar", "Quero mudar algo antes de lançar."), ("Descartar", "Descarta, não lança.")]
    return []


async def _entregar(chat: int | str, r, comprovante: bool = False) -> None:
    """Primeiro o que as ferramentas mostrariam (cartões e relatório, em texto), depois a fala do Jarvis com os botões."""
    from . import textos

    for card in r.cartoes[:4]:
        try:
            t = textos.cartao(card)
        except Exception as exc:  # noqa: BLE001
            log.warning("cartão em texto falhou: %s", exc)
            t = None
        if t:
            await enviar(chat, t, pronto=True)
    for m in r.mensagens:
        await enviar(chat, m, pronto=True)
    await enviar(chat, r.texto or "Pronto.", _botoes(r, comprovante))


# ---------------------------------------------------------------- lembretes e avisos


def _fuso():
    from zoneinfo import ZoneInfo

    from .config import settings

    try:
        return ZoneInfo(settings.fuso)
    except Exception:  # noqa: BLE001
        return ZoneInfo("America/Sao_Paulo")


def agendar_lembrete(chat: str, texto: str, quando: str) -> dict[str, Any]:
    try:
        t = dt.datetime.fromisoformat(quando.strip())
    except ValueError:
        return {"erro": "Não entendi a data e a hora. Use AAAA-MM-DDTHH:MM."}
    if t.tzinfo is None:
        t = t.replace(tzinfo=_fuso())
    if t.timestamp() < time.time() - 60:
        return {"erro": "Esse horário já passou."}
    lista = (store.get("lembretes") or {}).get("itens", [])
    lista.append({"id": uuid.uuid4().hex[:8], "chat": chat, "texto": texto, "em": t.timestamp()})
    store.put("lembretes", {"itens": lista})
    return {"ok": True, "quando": t.strftime("%d/%m às %H:%M"), "instrucao": "Confirme numa frase o dia e a hora."}


async def avisar(titulo: str, texto: str) -> bool:
    """Aviso do Jarvis (contas, orçamento, sistemas) no Telegram da pessoa. Devolve se mandou."""
    from . import nuvem

    chat = (store.get("telegram") or {}).get("chat")
    if not chat or not (nuvem.ligado() or TOKEN_DIRETO):
        return False
    await enviar(chat, f"<b>{html.escape(titulo)}</b>\n{html.escape(texto)}" if titulo else html.escape(texto), pronto=True)
    return True


async def loop() -> None:
    """Lembretes na hora certa."""
    while True:
        try:
            lista = (store.get("lembretes") or {}).get("itens", [])
            agora = time.time()
            vencidos = [x for x in lista if x["em"] <= agora]
            if vencidos:
                store.put("lembretes", {"itens": [x for x in lista if x["em"] > agora]})
                for x in vencidos:
                    await enviar(x["chat"], f"⏰ <b>Lembrete</b>\n{html.escape(x['texto'])}", pronto=True)
        except Exception as exc:  # noqa: BLE001 - laço de fundo não pode morrer
            log.warning("lembretes: %s", exc)
        await asyncio.sleep(20)
